// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockIsR2Available,
  mockGeneratePresignedPutUrl,
  mockHeadObject,
  mockReadObjectHead,
  mockDeleteObject,
  mockListObjects,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsR2Available: vi.fn(),
  mockGeneratePresignedPutUrl: vi.fn(),
  mockHeadObject: vi.fn(),
  mockReadObjectHead: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockListObjects: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: mockIsR2Available,
  generatePresignedPutUrl: mockGeneratePresignedPutUrl,
  headObject: mockHeadObject,
  readObjectHead: mockReadObjectHead,
  deleteObject: mockDeleteObject,
  listObjects: mockListObjects,
}));

// "%PDF-" — the leading bytes of a valid PDF, so the record path's signature check passes for the
// fixtures below, which all use a .pdf filename.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

import { SubmissionError } from "./submission-core";
import { SUBMISSIONS_MAX_FILE_SIZE_BYTES } from "./submission-constants";
import {
  createOrReplaceSubmission,
  finalizeSubmission,
  generateSubmissionUploadUrl,
  getSubmission,
  getSubmissionViewForRegistration,
  listCompetitionsDueForSubmissionPurge,
  purgeUnfinalizedSubmissionsForCompetition,
  resolveSubmissionAccess,
  sweepOrphanedObjectsForRegistration,
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
    selectDistinct: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
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
  fileKey: "submissions/comp_1/reg_1/abc",
  fileName: "report.pdf",
  fileSizeBytes: 1024,
  fileMimeType: "application/pdf",
  version: 1,
  finalizedAt: null,
  submittedAt: NOW_IN_WINDOW,
  updatedAt: NOW_IN_WINDOW,
};

const validMetadata = {
  fileKey: "submissions/comp_1/reg_1/abc",
  fileName: "report.pdf",
  fileSizeBytes: 1024,
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
  // The record path now confirms the stored object before writing: a HEAD for the real size and a
  // ranged read for the magic bytes. Defaults here describe a valid 1 KB PDF, matching the
  // `report.pdf` fixtures; individual tests override them to exercise rejection.
  beforeEach(() => {
    mockIsR2Available.mockReturnValue(true);
    mockHeadObject.mockResolvedValue({ sizeBytes: 1024, contentType: "application/pdf" });
    mockReadObjectHead.mockResolvedValue(PDF_BYTES);
    mockDeleteObject.mockResolvedValue(undefined);
  });
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
        { ...validMetadata, fileKey: "submissions/comp_1/reg_OTHER/abc" },
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
    const { db } = createDbMock([[individualRegRow], [], []]);
    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_finalized",
      422,
    );
  });

  it("creates a submission at version 1 on the happy path", async () => {
    const { db } = createDbMock([[individualRegRow], [], [{ ...submissionRecord, version: 1 }]]);
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
    const { db, calls } = createDbMock([
      [individualRegRow],
      [],
      [{ ...submissionRecord, version: 2 }],
    ]);
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

  // ── Content validation ────────────────────────────────────────────────────

  it("persists the size read back from R2, not the size the client claimed", async () => {
    mockHeadObject.mockResolvedValue({ sizeBytes: 4096, contentType: "application/pdf" });
    const { db, calls } = createDbMock([
      [individualRegRow],
      [],
      [{ ...submissionRecord, version: 1 }],
    ]);

    await createOrReplaceSubmission(
      "comp_1",
      "reg_1",
      "stud_1",
      // The client claims 1 KB; the object is really 4 KB.
      { ...validMetadata, fileSizeBytes: 1024 },
      db,
      NOW_IN_WINDOW,
    );

    expect((calls.upsert?.set as Record<string, unknown>)?.fileSizeBytes).toBe(4096);
  });

  // The record payload carries no MIME field at all (see ValidatedFileMetadata), so the stored
  // type can only come from the filename once the bytes beneath it are confirmed.
  it("persists the type derived from the confirmed file, for a name whose family is byte-checked", async () => {
    mockReadObjectHead.mockResolvedValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const { db, calls } = createDbMock([
      [individualRegRow],
      [],
      [{ ...submissionRecord, version: 1 }],
    ]);

    await createOrReplaceSubmission(
      "comp_1",
      "reg_1",
      "stud_1",
      { ...validMetadata, fileName: "deck.pptx" },
      db,
      NOW_IN_WINDOW,
    );

    // Zip bytes confirm the family; the .pptx extension selects the specific type within it.
    expect((calls.upsert?.set as Record<string, unknown>)?.fileMimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("rejects a file whose bytes disagree with its extension, and deletes it", async () => {
    // "PK\x03\x04" — zip bytes behind a .pdf name.
    mockReadObjectHead.mockResolvedValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const { db } = createDbMock([[individualRegRow]]);

    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_invalid_file_type",
      422,
    );
    expect(mockDeleteObject).toHaveBeenCalledWith(validMetadata.fileKey);
  });

  it("rejects a file with no recognised signature, and deletes it", async () => {
    mockReadObjectHead.mockResolvedValue(new Uint8Array([0x3c, 0x21, 0x64, 0x6f, 0x63]));
    const { db } = createDbMock([[individualRegRow]]);

    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_invalid_file_type",
      422,
    );
    expect(mockDeleteObject).toHaveBeenCalledWith(validMetadata.fileKey);
  });

  it("rejects an object over the size ceiling even when the client under-reported it", async () => {
    mockHeadObject.mockResolvedValue({
      sizeBytes: SUBMISSIONS_MAX_FILE_SIZE_BYTES + 1,
      contentType: "application/pdf",
    });
    const { db } = createDbMock([[individualRegRow]]);

    await expectCode(
      createOrReplaceSubmission(
        "comp_1",
        "reg_1",
        "stud_1",
        { ...validMetadata, fileSizeBytes: 10 },
        db,
        NOW_IN_WINDOW,
      ),
      "submission_invalid_file_type",
      422,
    );
    expect(mockDeleteObject).toHaveBeenCalledWith(validMetadata.fileKey);
  });

  it("reports a key with no object behind it rather than writing a row", async () => {
    mockHeadObject.mockResolvedValue(null);
    const { db } = createDbMock([[individualRegRow]]);

    await expectCode(
      createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW),
      "submission_file_missing",
      422,
    );
    // Nothing was stored, so nothing is deleted.
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("reclaims the object a replacement supersedes", async () => {
    const { db } = createDbMock([
      [individualRegRow],
      [{ ...submissionRecord, fileKey: "submissions/comp_1/reg_1/OLD" }],
      [{ ...submissionRecord, version: 2 }],
    ]);

    await createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW);

    expect(mockDeleteObject).toHaveBeenCalledWith("submissions/comp_1/reg_1/OLD");
  });

  it("does not delete anything when a replacement reuses the same key", async () => {
    const { db } = createDbMock([
      [individualRegRow],
      [{ ...submissionRecord, fileKey: validMetadata.fileKey }],
      [{ ...submissionRecord, version: 2 }],
    ]);

    await createOrReplaceSubmission("comp_1", "reg_1", "stud_1", validMetadata, db, NOW_IN_WINDOW);

    expect(mockDeleteObject).not.toHaveBeenCalled();
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
    mockListObjects.mockResolvedValue([]);
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
        { fileName: "report.pdf" },
        db,
        NOW_IN_WINDOW,
      ),
      "submission_upload_unavailable",
      503,
    );
    expect(mockGeneratePresignedPutUrl).not.toHaveBeenCalled();
  });

  it("refuses to sign an upload for an extension outside the allowlist", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    await expectCode(
      generateSubmissionUploadUrl(
        "comp_1",
        "reg_1",
        "stud_1",
        { fileName: "payload.html" },
        db,
        NOW_IN_WINDOW,
      ),
      "submission_invalid_file_type",
      422,
    );
    expect(mockGeneratePresignedPutUrl).not.toHaveBeenCalled();
  });

  it("binds the type implied by the filename, ignoring the client-declared MIME", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    const grant = await generateSubmissionUploadUrl(
      "comp_1",
      "reg_1",
      "stud_1",
      // The client claims HTML for a file named .pdf; the signed URL must bind the PDF type.
      { fileName: "report.pdf" },
      db,
      NOW_IN_WINDOW,
    );

    expect(grant.contentType).toBe("application/pdf");
    expect(mockGeneratePresignedPutUrl).toHaveBeenCalledWith(
      expect.stringContaining("submissions/comp_1/reg_1/"),
      "application/pdf",
      expect.any(Number),
    );
  });

  it("returns a presigned grant with a correctly scoped key on the happy path", async () => {
    const { db } = createDbMock([[individualRegRow]]);
    const grant = await generateSubmissionUploadUrl(
      "comp_1",
      "reg_1",
      "stud_1",
      { fileName: "report.pdf" },
      db,
      NOW_IN_WINDOW,
    );
    expect(grant.uploadUrl).toBe("https://signed.example/put");
    // Competition first, then registration — the layout a per-competition sweep depends on.
    expect(grant.fileKey).toMatch(/^submissions\/comp_1\/reg_1\//);
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
        { fileName: "report.pdf" },
        db,
        NOW_AFTER_WINDOW,
      ),
      "submission_window_closed",
      422,
    );
  });
});

describe("sweepOrphanedObjectsForRegistration", () => {
  const OLD = new Date(NOW_IN_WINDOW.getTime() - 60 * 60 * 1000);
  const RECENT = new Date(NOW_IN_WINDOW.getTime() - 5 * 1000);

  beforeEach(() => {
    mockIsR2Available.mockReturnValue(true);
    mockDeleteObject.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("deletes an aged object the current submission does not reference", async () => {
    mockListObjects.mockResolvedValue([
      { key: "submissions/comp_1/reg_1/ORPHAN", lastModified: OLD },
    ]);
    const { db } = createDbMock([[submissionRecord]]);

    await sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW);

    expect(mockDeleteObject).toHaveBeenCalledWith("submissions/comp_1/reg_1/ORPHAN");
  });

  it("keeps the object the current submission references", async () => {
    mockListObjects.mockResolvedValue([{ key: submissionRecord.fileKey, lastModified: OLD }]);
    const { db } = createDbMock([[submissionRecord]]);

    await sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW);

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  // An upload may be in flight against a key that has no row yet — deleting it mid-PUT would
  // destroy a submission the candidate is in the middle of making.
  it("leaves an object younger than the presign window alone", async () => {
    mockListObjects.mockResolvedValue([
      { key: "submissions/comp_1/reg_1/IN_FLIGHT", lastModified: RECENT },
    ]);
    const { db } = createDbMock([[]]);

    await sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW);

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("sweeps the registration's own prefix, not the whole competition", async () => {
    mockListObjects.mockResolvedValue([]);
    const { db } = createDbMock([[]]);

    await sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW);

    expect(mockListObjects).toHaveBeenCalledWith("submissions/comp_1/reg_1/");
  });

  it("never throws when storage errors — it runs beside an upload", async () => {
    mockListObjects.mockRejectedValue(new Error("r2_down"));
    const { db } = createDbMock([[]]);

    await expect(
      sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW),
    ).resolves.toBeUndefined();
  });

  it("does nothing when R2 is unconfigured", async () => {
    mockIsR2Available.mockReturnValue(false);
    const { db } = createDbMock([[]]);

    await sweepOrphanedObjectsForRegistration("comp_1", "reg_1", db, NOW_IN_WINDOW);

    expect(mockListObjects).not.toHaveBeenCalled();
  });
});

describe("purgeUnfinalizedSubmissionsForCompetition", () => {
  const FINALIZED = {
    registrationId: "reg_final",
    fileKey: "submissions/comp_1/reg_final/KEEP",
    finalizedAt: NOW_IN_WINDOW,
  };
  const DRAFT = {
    registrationId: "reg_draft",
    fileKey: "submissions/comp_1/reg_draft/DROP",
    finalizedAt: null,
  };

  beforeEach(() => {
    mockIsR2Available.mockReturnValue(true);
    mockDeleteObject.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  // The load-bearing guarantee: a finalized entry is the participant's work and the basis of any
  // published result. It must survive the purge untouched, bytes and row alike.
  it("keeps a finalized submission's object and row, and drops an unfinalized one", async () => {
    mockListObjects.mockResolvedValue([
      { key: FINALIZED.fileKey, lastModified: NOW_IN_WINDOW },
      { key: DRAFT.fileKey, lastModified: NOW_IN_WINDOW },
    ]);
    const { db } = createDbMock([[FINALIZED, DRAFT], [{ registrationId: "reg_draft" }]]);

    const outcome = await purgeUnfinalizedSubmissionsForCompetition("comp_1", db);

    expect(mockDeleteObject).toHaveBeenCalledExactlyOnceWith(DRAFT.fileKey);
    expect(outcome).toEqual({ objectsDeleted: 1, rowsDeleted: 1, finalizedKept: 1 });
  });

  // Deleting from the prefix rather than from the rows is what reaches an upload the database
  // never recorded — the case a row-driven purge can never find.
  it("deletes an object no surviving row references", async () => {
    mockListObjects.mockResolvedValue([
      { key: FINALIZED.fileKey, lastModified: NOW_IN_WINDOW },
      { key: "submissions/comp_1/reg_x/FORGOTTEN", lastModified: NOW_IN_WINDOW },
    ]);
    const { db } = createDbMock([[FINALIZED]]);

    const outcome = await purgeUnfinalizedSubmissionsForCompetition("comp_1", db);

    expect(mockDeleteObject).toHaveBeenCalledExactlyOnceWith("submissions/comp_1/reg_x/FORGOTTEN");
    expect(outcome.rowsDeleted).toBe(0);
  });

  it("lists exactly one prefix — the competition's", async () => {
    mockListObjects.mockResolvedValue([]);
    const { db } = createDbMock([[]]);

    await purgeUnfinalizedSubmissionsForCompetition("comp_1", db);

    expect(mockListObjects).toHaveBeenCalledExactlyOnceWith("submissions/comp_1/");
  });

  it("touches nothing when every submission is finalized", async () => {
    mockListObjects.mockResolvedValue([{ key: FINALIZED.fileKey, lastModified: NOW_IN_WINDOW }]);
    const { db } = createDbMock([[FINALIZED]]);

    const outcome = await purgeUnfinalizedSubmissionsForCompetition("comp_1", db);

    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(outcome).toEqual({ objectsDeleted: 0, rowsDeleted: 0, finalizedKept: 1 });
  });

  it("refuses rather than half-purging when storage is unavailable", async () => {
    mockIsR2Available.mockReturnValue(false);
    const { db } = createDbMock([[DRAFT]]);

    await expectCode(
      purgeUnfinalizedSubmissionsForCompetition("comp_1", db),
      "submission_upload_unavailable",
      503,
    );
    expect(mockListObjects).not.toHaveBeenCalled();
  });
});

describe("listCompetitionsDueForSubmissionPurge", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the distinct competition ids the query matched", async () => {
    const { db } = createDbMock([[{ competitionId: "comp_1" }, { competitionId: "comp_2" }]]);
    const due = await listCompetitionsDueForSubmissionPurge(90, db, NOW_IN_WINDOW);
    expect(due).toEqual(["comp_1", "comp_2"]);
  });

  // The three conditions that bound what gets deleted live in the WHERE clause, which this mock
  // ignores. They are asserted against the compiled SQL in submission-purge-predicate.test.ts;
  // driving them against real rows is still owed at 6.4-UAT.
  it("returns empty when nothing matched", async () => {
    const { db } = createDbMock([[]]);
    expect(await listCompetitionsDueForSubmissionPurge(90, db, NOW_IN_WINDOW)).toEqual([]);
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
    const view = await getSubmissionViewForRegistration("reg_1", "stud_other", db, NOW_IN_WINDOW);
    expect(view).toBeNull();
  });
});
