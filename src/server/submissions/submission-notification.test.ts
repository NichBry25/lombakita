// @vitest-environment node
// Tests that submission.finalized enqueue fires exactly once on finalize, not on
// upload/replace, and that enqueue failure does not surface to the caller.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockIsR2Available,
  mockHeadObject,
  mockReadObjectHead,
  enqueueSubmissionFinalized,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsR2Available: vi.fn(),
  mockHeadObject: vi.fn(),
  mockReadObjectHead: vi.fn(),
  enqueueSubmissionFinalized: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: mockIsR2Available,
  generatePresignedPutUrl: vi.fn(),
  headObject: mockHeadObject,
  readObjectHead: mockReadObjectHead,
  deleteObject: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/async/enqueue", () => ({ enqueueSubmissionFinalized }));

import { finalizeSubmission, createOrReplaceSubmission } from "./submission-service";
import { SubmissionError } from "./submission-core";

const NOW = new Date("2026-06-10T12:00:00.000Z");

// FIFO DB mock.
// selectQueues: each select() dequeues one result set.
// updateReturn: what the update().returning() resolves to.
// insertReturn: what the insert().returning() resolves to (for UPSERT in createOrReplace).
function makeDb(
  selectQueues: unknown[][],
  opts: { updateReturn?: unknown[]; insertReturn?: unknown[] } = {},
) {
  const queue = [...selectQueues];
  const nextRows = (): unknown[] => (queue.length > 0 ? (queue.shift() as unknown[]) : []);

  const makeChain = (returning: () => Promise<unknown[]>) => {
    const c: Record<string, unknown> = {};
    for (const m of [
      "from",
      "innerJoin",
      "leftJoin",
      "where",
      "limit",
      "orderBy",
      "values",
      "onConflictDoUpdate",
      "onConflictDoNothing",
      "set",
    ]) {
      c[m] = vi.fn(() => c);
    }
    c.returning = vi.fn(() => returning());
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      returning().then(res, rej);
    return c;
  };

  const select = vi.fn(() => makeChain(async () => nextRows()));
  const insert = vi.fn(() => makeChain(async () => opts.insertReturn ?? []));
  const update = vi.fn(() => makeChain(async () => opts.updateReturn ?? []));

  return { select, insert, update };
}

const confirmedRegistrationRow = {
  registrationId: "reg_1",
  competitionId: "comp_1",
  registrationType: "individual" as const,
  registrationStatus: "confirmed" as const,
  studentId: "stud_1",
  teamId: null,
  competitionTitle: "Lomba X",
  competitionSlug: "lomba-x",
  eventStartAt: new Date("2026-06-01"),
  eventEndAt: new Date("2026-06-30"),
};

const submissionRow = {
  id: "sub_1",
  registrationId: "reg_1",
  submittedById: "stud_1",
  fileKey: "submissions/comp_1/reg_1/file.pdf",
  fileName: "file.pdf",
  fileSizeBytes: 1000,
  fileMimeType: "application/pdf",
  version: 1,
  finalizedAt: NOW,
  submittedAt: NOW,
  updatedAt: NOW,
};

describe("finalizeSubmission — notification enqueue", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("calls enqueueSubmissionFinalized once on successful finalize", async () => {
    enqueueSubmissionFinalized.mockResolvedValue({});

    const db = makeDb(
      [
        [confirmedRegistrationRow], // loadRegistrationWithCompetition
        [{ ...submissionRow, finalizedAt: null }], // getSubmissionRow (existing, not finalized)
      ],
      { updateReturn: [submissionRow] },
    );
    mockGetDb.mockReturnValue(db);

    await finalizeSubmission("comp_1", "reg_1", "stud_1", db as never);

    expect(enqueueSubmissionFinalized).toHaveBeenCalledOnce();
    expect(enqueueSubmissionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "sub_1",
        registrationId: "reg_1",
        studentId: "stud_1",
        competitionId: "comp_1",
      }),
    );
  });

  it("does NOT call enqueueSubmissionFinalized when no submission exists", async () => {
    const db = makeDb([
      [confirmedRegistrationRow],
      [], // no existing submission
    ]);
    mockGetDb.mockReturnValue(db);

    await expect(
      finalizeSubmission("comp_1", "reg_1", "stud_1", db as never),
    ).rejects.toBeInstanceOf(SubmissionError);

    expect(enqueueSubmissionFinalized).not.toHaveBeenCalled();
  });

  it("returns the finalized submission even when enqueue throws (fire-and-forget)", async () => {
    enqueueSubmissionFinalized.mockRejectedValue(new Error("redis_down"));

    const db = makeDb([[confirmedRegistrationRow], [{ ...submissionRow, finalizedAt: null }]], {
      updateReturn: [submissionRow],
    });
    mockGetDb.mockReturnValue(db);

    const result = await finalizeSubmission("comp_1", "reg_1", "stud_1", db as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.id).toBe("sub_1");
  });
});

describe("createOrReplaceSubmission — no notification enqueue", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("does NOT call enqueueSubmissionFinalized on file upload/replace", async () => {
    mockIsR2Available.mockReturnValue(true);
    // The record path confirms the stored object before writing: a valid 1 KB PDF here.
    mockHeadObject.mockResolvedValue({ sizeBytes: 1024, contentType: "application/pdf" });
    mockReadObjectHead.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    const db = makeDb([[confirmedRegistrationRow]], {
      insertReturn: [{ ...submissionRow, finalizedAt: null }],
    });
    mockGetDb.mockReturnValue(db);

    await createOrReplaceSubmission(
      "comp_1",
      "reg_1",
      "stud_1",
      {
        fileKey: "submissions/comp_1/reg_1/file.pdf",
        fileName: "file.pdf",
        fileSizeBytes: null,
      },
      db as never,
      NOW,
    );

    expect(enqueueSubmissionFinalized).not.toHaveBeenCalled();
  });
});
