// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockIsR2Available, mockGeneratePresignedPutUrl } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsR2Available: vi.fn(),
  mockGeneratePresignedPutUrl: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: mockIsR2Available,
  generatePresignedPutUrl: mockGeneratePresignedPutUrl,
}));

import { SubmissionError } from "./submission-core";
import {
  createOrReplaceSubmission,
  finalizeSubmission,
  generateSubmissionUploadUrl,
  getSubmission,
  getSubmissionViewForRegistration,
  resolveSubmissionAccess,
} from "./submission-service";

// FIFO queue of result-arrays. Each awaited SELECT chain and each `.returning()` shifts one entry.
// `calls` captures the last upsert config and update set for structural assertions.
function createDbMock(results: unknown[][]) {
  const queue = [...results];
  const next = (): unknown[] => (queue.length > 0 ? (queue.shift() as unknown[]) : []);
  const calls: { upsert?: Record<string, unknown>; updateSet?: Record<string, unknown> } = {};

  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "values"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.set = vi.fn((value: Record<string, unknown>) => {
      calls.updateSet = value;
      return chain;
    });
    chain.onConflictDoUpdate = vi.fn((config: Record<string, unknown>) => {
      calls.upsert = config;
      return chain;
    });
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(next()));
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject);
    return chain;
  };

  const db = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
  };

  return { db: db as never, calls };
}

const EVENT_START = new Date("2026-06-01T00:00:00.000Z");
const EVENT_END = new Date("2026-06-30T00:00:00.000Z");
const NOW_IN_WINDOW = new Date("2026-06-15T00:00:00.000Z");
const NOW_AFTER_WINDOW = new Date("2026-07-15T00:00:00.000Z");

const individualRegRow = {
  registrationId: "reg_1",
  competitionId: "comp_1",
  registrationType: "individual",
  registrationStatus: "confirmed",
  studentId: "stud_1",
  teamId: null,
  competitionTitle: "Hackathon",
  competitionSlug: "hackathon",
  eventStartAt: EVENT_START,
  eventEndAt: EVENT_END,
};

const cancelledRegRow = { ...individualRegRow, registrationStatus: "cancelled" };

const teamRegRow = {
  ...individualRegRow,
  registrationType: "team",
  studentId: "captain_1",
  teamId: "team_1",
};

const submissionRecord = {
  id: "sub_1",
  registrationId: "reg_1",
  submittedById: "stud_1",
  fileKey: "submissions/reg_1/abc",
  fileName: "report.pdf",
  fileSizeBytes: 1024,
  fileMimeType: "application/pdf",
  version: 1,
  finalizedAt: null,
  submittedAt: NOW_IN_WINDOW,
  updatedAt: NOW_IN_WINDOW,
};

const validMetadata = {
  fileKey: "submissions/reg_1/abc",
  fileName: "report.pdf",
  fileSizeBytes: 1024,
  fileMimeType: "application/pdf",
};

const expectCode = async (promise: Promise<unknown>, code: string, status?: number) => {
  await expect(promise).rejects.toBeInstanceOf(SubmissionError);
  try {
    await promise;
  } catch (e) {
    expect((e as SubmissionError).code).toBe(code);
    if (status !== undefined) expect((e as SubmissionError).status).toBe(status);
  }
};

describe("resolveSubmissionAccess", () => {
  afterEach(() => vi.clearAllMocks());

  it("individual owner passes", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    const result = await resolveSubmissionAccess("comp_1", "reg_1", "stud_1", db);
    expect(result?.registration.id).toBe("reg_1");
  });

  it("individual stranger fails (null)", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    const result = await resolveSubmissionAccess("comp_1", "reg_1", "stud_2", db);
    expect(result).toBeNull();
  });

  it("team active member passes", async () => {
    const { db } = createDbMock([[teamRegRow], [{ id: "m_1" }]]);
    const result = await resolveSubmissionAccess("comp_1", "reg_1", "member_9", db);
    expect(result?.registration.teamId).toBe("team_1");
  });

  it("team non-member fails (null)", async () => {
    const { db } = createDbMock([[teamRegRow], []]);
    const result = await resolveSubmissionAccess("comp_1", "reg_1", "stranger", db);
    expect(result).toBeNull();
  });

  it("cross-competition IDOR fails (null)", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    // URL competitionId comp_2 does not own reg_1 (which belongs to comp_1)
    const result = await resolveSubmissionAccess("comp_2", "reg_1", "stud_1", db);
    expect(result).toBeNull();
  });

  it("missing registration fails (null)", async () => {
    const { db } = createDbMock([[]]);
    const result = await resolveSubmissionAccess("comp_1", "reg_x", "stud_1", db);
    expect(result).toBeNull();
  });
});

describe("getSubmission", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the submission when access is granted", async () => {
    const { db } = createDbMock([[individualRegRow], [submissionRecord]]);
    const result = await getSubmission("comp_1", "reg_1", "stud_1", db);
    expect(result?.id).toBe("sub_1");
  });

  it("returns null when access is granted but no submission exists", async () => {
    const { db } = createDbMock([[individualRegRow], []]);
    const result = await getSubmission("comp_1", "reg_1", "stud_1", db);
    expect(result).toBeNull();
  });

  it("throws submission_registration_not_found (404) when inaccessible", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      getSubmission("comp_1", "reg_1", "stranger", db),
      "submission_registration_not_found",
      404,
    );
  });

  it("blocks a cancelled registration (409)", async () => {
    const { db } = createDbMock([[cancelledRegRow]]);
    await expectCode(
      getSubmission("comp_1", "reg_1", "stud_1", db),
      "submission_registration_cancelled",
      409,
    );
  });
});

describe("createOrReplaceSubmission", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejects when the submission window is closed", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_AFTER_WINDOW),
      "submission_window_closed",
      422,
    );
  });

  it("rejects a fileKey not scoped to the registration (422 submission_invalid_file_key)", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      createOrReplaceSubmission(
        "comp_1",
        "reg_1",
        "stud_1",
        { ...validMetadata, fileKey: "submissions/reg_OTHER/abc" },
        db,
        NOW_IN_WINDOW,
      ),
      "submission_invalid_file_key",
      422,
    );
  });

  it("blocks a cancelled registration (409)", async () => {
    const { db } = createDbMock([[cancelledRegRow]]);
    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_registration_cancelled",
      409,
    );
  });

  it("rejects when the upsert matches a finalized row (0 rows → 422 submission_finalized)", async () => {
    const { db } = createDbMock([[individualRegRow], []]);
    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_finalized",
      422,
    );
  });

  it("creates a submission at version 1 on the happy path", async () => {
    const { db } = createDbMock([[individualRegRow], [{ ...submissionRecord, version: 1 }]]);
    const result = await createOrReplaceSubmission(
      "comp_1",
      "reg_1",
      "stud_1",
      validMetadata,
      db,
      NOW_IN_WINDOW,
    );
    expect(result.version).toBe(1);
  });

  it("replaces with the finalized-guard upsert (setWhere) and increments version via SQL", async () => {
    const { db, calls } = createDbMock([[individualRegRow], [{ ...submissionRecord, version: 2 }]]);
    const result = await createOrReplaceSubmission(
      "comp_1",
      "reg_1",
      "stud_1",
      validMetadata,
      db,
      NOW_IN_WINDOW,
    );
    expect(result.version).toBe(2);
    // The finalized guard lives in the DB WHERE of the conflict update, not a read-before-write.
    expect(calls.upsert?.setWhere).toBeDefined();
    // version increment is expressed as SQL in the conflict-update set clause.
    expect((calls.upsert?.set as Record<string, unknown>)?.version).toBeDefined();
  });
});

describe("finalizeSubmission", () => {
  afterEach(() => vi.clearAllMocks());

  it("finalizes the submission on the happy path", async () => {
    const finalized = { ...submissionRecord, finalizedAt: NOW_IN_WINDOW };
    const { db } = createDbMock([[individualRegRow], [submissionRecord], [finalized]]);
    const result = await finalizeSubmission("comp_1", "reg_1", "stud_1", db);
    expect(result.finalizedAt).not.toBeNull();
  });

  it("throws submission_not_found when there is no submission to finalize", async () => {
    const { db } = createDbMock([[individualRegRow], []]);
    await expectCode(
      finalizeSubmission("comp_1", "reg_1", "stud_1", db),
      "submission_not_found",
      404,
    );
  });

  it("rejects an already-finalized submission (0-row update → 409 submission_finalized)", async () => {
    const { db } = createDbMock([[individualRegRow], [submissionRecord], []]);
    await expectCode(
      finalizeSubmission("comp_1", "reg_1", "stud_1", db),
      "submission_finalized",
      409,
    );
  });
});

describe("generateSubmissionUploadUrl", () => {
  beforeEach(() => {
    mockIsR2Available.mockReturnValue(true);
    mockGeneratePresignedPutUrl.mockResolvedValue("https://signed.example/put");
  });
  afterEach(() => vi.clearAllMocks());

  it("rejects with 503 submission_upload_unavailable when R2 is not configured", async () => {
    mockIsR2Available.mockReturnValue(false);
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      generateSubmissionUploadUrl(
        "comp_1",
        "reg_1",
        "stud_1",
        { fileName: "report.pdf", fileMimeType: null },
        db,
        NOW_IN_WINDOW,
      ),
      "submission_upload_unavailable",
      503,
    );
    expect(mockGeneratePresignedPutUrl).not.toHaveBeenCalled();
  });

  it("returns a presigned grant with a correctly scoped key on the happy path", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    const grant = await generateSubmissionUploadUrl(
      "comp_1",
      "reg_1",
      "stud_1",
      { fileName: "report.pdf", fileMimeType: "application/pdf" },
      db,
      NOW_IN_WINDOW,
    );
    expect(grant.uploadUrl).toBe("https://signed.example/put");
    expect(grant.fileKey).toMatch(/^submissions\/reg_1\//);
    expect(grant.expiresAt).toBeInstanceOf(Date);
    expect(mockGeneratePresignedPutUrl).toHaveBeenCalledWith(grant.fileKey, "application/pdf", 900);
  });

  it("rejects with submission_window_closed outside the window", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      generateSubmissionUploadUrl(
        "comp_1",
        "reg_1",
        "stud_1",
        { fileName: "report.pdf", fileMimeType: null },
        db,
        NOW_AFTER_WINDOW,
      ),
      "submission_window_closed",
      422,
    );
  });
});

// Step 6.3 — 4.6-D3: getSubmissionViewForRegistration no-submission sentinel test.
describe("getSubmissionViewForRegistration", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns view with null submission when registration exists but has no submission row", async () => {
    // Query 0: loadRegistrationWithCompetition → [row]
    // Query 1: getSubmissionRow → [] (no submission)
    const { db } = createDbMock([[individualRegRow], []]);
    const view = await getSubmissionViewForRegistration("reg_1", "stud_1", db, NOW_IN_WINDOW);
    expect(view).not.toBeNull();
    expect(view?.submission).toBeNull();
    expect(view?.competitionId).toBe("comp_1");
  });

  it("returns null when the registration does not exist (no access)", async () => {
    const { db } = createDbMock([[]]);
    const view = await getSubmissionViewForRegistration("reg_x", "stud_1", db, NOW_IN_WINDOW);
    expect(view).toBeNull();
  });

  it("returns null when the caller is not the registrant (IDOR guard)", async () => {
    // Individual registration belongs to stud_1 — stud_other is the stranger.
    // loadRegistrationWithCompetition → [row], then canAccessRegistration → false (no DB call for individual).
    // getSubmissionViewForRegistration must return null.
    const { db } = createDbMock([[individualRegRow]]);
    const view = await getSubmissionViewForRegistration(
      "reg_1",
      "stud_other",
      db,
      NOW_IN_WINDOW,
    );
    expect(view).toBeNull();
  });
});
