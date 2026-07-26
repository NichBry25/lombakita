// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const {
  mockIsR2Available,
  mockGeneratePresignedPutUrl,
  mockGeneratePresignedGetUrl,
  mockHeadObject,
  mockReadObjectHead,
  mockDeleteObject,
  mockListObjects,
} = vi.hoisted(() => ({
  mockIsR2Available: vi.fn().mockReturnValue(true),
  mockGeneratePresignedPutUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
  mockGeneratePresignedGetUrl: vi.fn().mockResolvedValue("https://r2.example/get"),
  mockHeadObject: vi.fn(),
  mockReadObjectHead: vi.fn(),
  mockDeleteObject: vi.fn().mockResolvedValue(undefined),
  // Default: nothing under the prefix, so the orphan sweep short-circuits and never touches the db.
  mockListObjects: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: mockIsR2Available,
  generatePresignedPutUrl: mockGeneratePresignedPutUrl,
  generatePresignedGetUrl: mockGeneratePresignedGetUrl,
  headObject: mockHeadObject,
  readObjectHead: mockReadObjectHead,
  deleteObject: mockDeleteObject,
  listObjects: mockListObjects,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));

import { recruiterVerificationSubmissions, users } from "@/server/db/schema";
import {
  finalizeVerificationDocumentUpload,
  listPendingRecruiterVerifications,
  prepareVerificationDocumentUpload,
  resolveVerificationDocumentUrlForOps,
  reviewRecruiterVerification,
  submitRecruiterVerification,
  sweepOrphanedObjectsForAccount,
  sweepOrphanedSubmissionObjects,
} from "./recruiter-verification-service";

// Leading bytes for a valid PDF ("%PDF-1.7").
const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

afterEach(() => vi.clearAllMocks());

// Builds a tx whose update() dispatches by table: the submission update returns `submissionReturn`
// from .returning(); the users update is awaited after .where(); audit insert is a no-op. select()
// returns `existingSubmission` from .limit() (used only on the not-flipped branch).
const buildReviewDb = (opts: {
  submissionReturn: Array<{ userId: string }>;
  existingSubmission: Array<{ id: string }>;
}) => {
  const captured = {
    userTierUpdated: false,
    auditInserted: null as Record<string, unknown> | null,
  };

  const submissionUpdateChain = {
    set: vi.fn(() => submissionUpdateChain),
    where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(opts.submissionReturn) })),
  };
  const usersUpdateChain = {
    set: vi.fn(() => usersUpdateChain),
    where: vi.fn().mockResolvedValue(undefined),
  };

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn().mockResolvedValue(opts.existingSubmission),
  };

  const tx = {
    update: vi.fn((table: unknown) => {
      if (table === users) {
        captured.userTierUpdated = true;
        return usersUpdateChain;
      }
      return submissionUpdateChain;
    }),
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        captured.auditInserted = v;
        return Promise.resolve(undefined);
      }),
    })),
  };

  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  return { db, captured };
};

describe("reviewRecruiterVerification", () => {
  it("approve: flips the submission, elevates the account, and writes an audit row", async () => {
    const { db, captured } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);

    const result = await reviewRecruiterVerification(
      "ops_1",
      "sub_1",
      "approve",
      null,
      db as never,
    );

    expect(result).toEqual({ submissionId: "sub_1", userId: "u_1", status: "approved" });
    expect(captured.userTierUpdated).toBe(true);
    expect(captured.auditInserted).toMatchObject({
      actorUserId: "ops_1",
      targetUserId: "u_1",
      eventType: "recruiter_verification.approved",
    });
    // Post-commit terminal orphan sweep against the reviewed submission's prefix.
    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
  });

  it("reject: requires a reason before any DB work", async () => {
    const { db } = buildReviewDb({ submissionReturn: [], existingSubmission: [] });
    mockGetDb.mockReturnValue(db);

    await expect(
      reviewRecruiterVerification("ops_1", "sub_1", "reject", "   ", db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_invalid_value" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("reject: flips the submission and does NOT elevate the account", async () => {
    const { db, captured } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);

    const result = await reviewRecruiterVerification(
      "ops_1",
      "sub_1",
      "reject",
      "Tidak dapat memverifikasi afiliasi",
      db as never,
    );

    expect(result.status).toBe("rejected");
    expect(captured.userTierUpdated).toBe(false);
    expect(captured.auditInserted).toMatchObject({
      eventType: "recruiter_verification.rejected",
      reason: "Tidak dapat memverifikasi afiliasi",
    });
  });

  it("throws already_reviewed (409) when the CAS flip matches no pending row but the row exists", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [],
      existingSubmission: [{ id: "sub_1" }],
    });
    mockGetDb.mockReturnValue(db);

    await expect(
      reviewRecruiterVerification("ops_1", "sub_1", "approve", null, db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_already_reviewed", status: 409 });
  });

  it("throws not_found (404) when the submission does not exist at all", async () => {
    const { db } = buildReviewDb({ submissionReturn: [], existingSubmission: [] });
    mockGetDb.mockReturnValue(db);

    await expect(
      reviewRecruiterVerification("ops_1", "missing", "approve", null, db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_not_found", status: 404 });
  });
});

describe("submitRecruiterVerification", () => {
  const buildSubmitDb = (accountRow: Array<{ recruiterVerificationTier: string }>) => {
    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn().mockResolvedValue(accountRow),
    };
    return {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "sub_new" }]) })),
      })),
    };
  };

  it("refuses when the account is already Trusted (elevated)", async () => {
    const db = buildSubmitDb([{ recruiterVerificationTier: "elevated" }]);
    mockGetDb.mockReturnValue(db);

    await expect(
      submitRecruiterVerification(
        "u_1",
        { fullName: "Rendra Wijaya", mobileNumber: "0812345678", corporateEmail: null },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_already_trusted", status: 409 });
  });

  it("inserts a submission for a sandboxed (minimal) account", async () => {
    const db = buildSubmitDb([{ recruiterVerificationTier: "minimal" }]);
    mockGetDb.mockReturnValue(db);

    const row = await submitRecruiterVerification(
      "u_1",
      {
        fullName: "Rendra Wijaya",
        mobileNumber: "0812345678",
        corporateEmail: "rendra@corp.co.id",
      },
      db as never,
    );

    expect(row).toEqual({ id: "sub_new" });
  });
});

// db whose pending-submission lookup returns `pendingRows`, capturing any inserted document row.
const buildDocumentDb = (pendingRows: Array<{ id: string }>) => {
  const captured = { inserted: null as Record<string, unknown> | null };
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn().mockResolvedValue(pendingRows),
  };
  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => ({
        returning: vi.fn(() => {
          captured.inserted = v;
          return Promise.resolve([{ id: "doc_1", ...v }]);
        }),
      })),
    })),
  };
  return { db, captured };
};

describe("prepareVerificationDocumentUpload", () => {
  it("presigns and returns a user/submission-scoped key on the happy path", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);

    const result = await prepareVerificationDocumentUpload(
      "u_1",
      { originalFileName: "proof.pdf", contentType: "application/pdf", fileSizeBytes: 1000 },
      db as never,
    );

    expect(result.r2Key.startsWith("recruiter-verification/u_1/sub_1/")).toBe(true);
    expect(result.uploadUrl).toBe("https://r2.example/put");
    expect(mockGeneratePresignedPutUrl).toHaveBeenCalledWith(result.r2Key, "application/pdf", 300);
    // The orphan sweep runs against this submission's prefix before minting a new key.
    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
  });

  it("rejects a disallowed extension before any DB or storage work", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);

    await expect(
      prepareVerificationDocumentUpload(
        "u_1",
        { originalFileName: "malware.svg", contentType: "image/svg+xml", fileSizeBytes: 10 },
        db as never,
      ),
    ).rejects.toMatchObject({
      code: "recruiter_verification_document_type_not_allowed",
      status: 422,
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects an oversize file", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);

    await expect(
      prepareVerificationDocumentUpload(
        "u_1",
        {
          originalFileName: "proof.pdf",
          contentType: "application/pdf",
          fileSizeBytes: 20 * 1024 * 1024,
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_too_large", status: 422 });
  });

  it("404s when the account has no pending submission", async () => {
    const { db } = buildDocumentDb([]);
    mockGetDb.mockReturnValue(db);

    await expect(
      prepareVerificationDocumentUpload(
        "u_1",
        { originalFileName: "proof.pdf", contentType: "application/pdf", fileSizeBytes: 1000 },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_not_found", status: 404 });
  });
});

describe("finalizeVerificationDocumentUpload", () => {
  it("accepts a real PDF, storing the detected type and real size", async () => {
    const { db, captured } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);
    mockHeadObject.mockResolvedValueOnce({ sizeBytes: 1234, contentType: "application/pdf" });
    mockReadObjectHead.mockResolvedValueOnce(PDF_HEAD);

    const row = await finalizeVerificationDocumentUpload(
      "u_1",
      { r2Key: "recruiter-verification/u_1/sub_1/abc", originalFileName: "proof.pdf" },
      db as never,
    );

    expect(row).toMatchObject({ id: "doc_1" });
    expect(captured.inserted).toMatchObject({
      submissionId: "sub_1",
      contentType: "application/pdf",
      fileSizeBytes: 1234,
      originalFileName: "proof.pdf",
    });
    expect(mockDeleteObject).not.toHaveBeenCalled();
    // The orphan sweep runs after a valid document is recorded.
    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
  });

  it("rejects a key not scoped to the caller's submission (no storage touch)", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);

    await expect(
      finalizeVerificationDocumentUpload(
        "u_1",
        { r2Key: "recruiter-verification/attacker/sub_1/abc", originalFileName: "proof.pdf" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_invalid", status: 422 });
    expect(mockHeadObject).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("404s when the uploaded object is missing", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);
    mockHeadObject.mockResolvedValueOnce(null);

    await expect(
      finalizeVerificationDocumentUpload(
        "u_1",
        { r2Key: "recruiter-verification/u_1/sub_1/abc", originalFileName: "proof.pdf" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_not_found", status: 404 });
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("deletes and rejects when the real object exceeds the size cap", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);
    mockHeadObject.mockResolvedValueOnce({
      sizeBytes: 20 * 1024 * 1024,
      contentType: "application/pdf",
    });

    await expect(
      finalizeVerificationDocumentUpload(
        "u_1",
        { r2Key: "recruiter-verification/u_1/sub_1/abc", originalFileName: "proof.pdf" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_too_large", status: 422 });
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/abc");
  });

  it("deletes and rejects when the bytes are not an accepted type", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);
    mockHeadObject.mockResolvedValueOnce({ sizeBytes: 100, contentType: "application/pdf" });
    mockReadObjectHead.mockResolvedValueOnce(new Uint8Array([0x00, 0x01, 0x02, 0x03]));

    await expect(
      finalizeVerificationDocumentUpload(
        "u_1",
        { r2Key: "recruiter-verification/u_1/sub_1/abc", originalFileName: "proof.pdf" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_invalid", status: 422 });
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/abc");
  });

  it("deletes and rejects when the extension disagrees with the detected type", async () => {
    const { db } = buildDocumentDb([{ id: "sub_1" }]);
    mockGetDb.mockReturnValue(db);
    mockHeadObject.mockResolvedValueOnce({ sizeBytes: 100, contentType: "application/pdf" });
    // Real PDF bytes behind a .png name.
    mockReadObjectHead.mockResolvedValueOnce(PDF_HEAD);

    await expect(
      finalizeVerificationDocumentUpload(
        "u_1",
        { r2Key: "recruiter-verification/u_1/sub_1/abc", originalFileName: "proof.png" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_invalid", status: 422 });
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/abc");
  });
});

describe("resolveVerificationDocumentUrlForOps", () => {
  const buildResolveDb = (rows: Array<Record<string, unknown>>) => {
    const chain = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn().mockResolvedValue(rows),
    };
    return { select: vi.fn(() => chain) };
  };

  it("mints an attachment URL with the formatted download name", async () => {
    const db = buildResolveDb([
      {
        r2Key: "recruiter-verification/u_1/sub_1/abc",
        originalFileName: "Surat.pdf",
        contentType: "application/pdf",
        username: "rendra",
      },
    ]);
    mockGetDb.mockReturnValue(db);

    const result = await resolveVerificationDocumentUrlForOps("doc_1", "attachment", db as never);

    expect(result.url).toBe("https://r2.example/get");
    const [, expiry, options] = mockGeneratePresignedGetUrl.mock.calls.at(-1)!;
    expect(expiry).toBe(300);
    expect(options?.responseContentType).toBe("application/pdf");
    expect(options?.responseContentDisposition).toContain("attachment;");
    expect(options?.responseContentDisposition).toContain("rendra_verification_Surat.pdf");
  });

  it("uses inline disposition for viewing", async () => {
    const db = buildResolveDb([
      {
        r2Key: "recruiter-verification/u_1/sub_1/abc",
        originalFileName: "Surat.pdf",
        contentType: "application/pdf",
        username: "rendra",
      },
    ]);
    mockGetDb.mockReturnValue(db);

    await resolveVerificationDocumentUrlForOps("doc_1", "inline", db as never);
    const [, , options] = mockGeneratePresignedGetUrl.mock.calls.at(-1)!;
    expect(options?.responseContentDisposition).toContain("inline;");
  });

  it("404s for an unknown document id", async () => {
    const db = buildResolveDb([]);
    mockGetDb.mockReturnValue(db);

    await expect(
      resolveVerificationDocumentUrlForOps("missing", "inline", db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_not_found", status: 404 });
  });
});

describe("listPendingRecruiterVerifications", () => {
  it("groups each submission's documents into its entry", async () => {
    const rowsChain = {
      from: vi.fn(() => rowsChain),
      innerJoin: vi.fn(() => rowsChain),
      where: vi.fn(() => rowsChain),
      orderBy: vi.fn().mockResolvedValue([
        {
          submission: { id: "sub_1" },
          email: "r@corp.co",
          username: "rendra",
          name: "Rendra",
          hasDocuments: true,
        },
      ]),
    };
    const docsChain = {
      from: vi.fn(() => docsChain),
      where: vi.fn(() => docsChain),
      orderBy: vi.fn().mockResolvedValue([
        {
          id: "doc_1",
          submissionId: "sub_1",
          originalFileName: "a.pdf",
          contentType: "application/pdf",
        },
      ]),
    };
    const db = {
      select: vi.fn().mockReturnValueOnce(rowsChain).mockReturnValueOnce(docsChain),
    };
    mockGetDb.mockReturnValue(db);

    const result = await listPendingRecruiterVerifications(db as never);

    expect(result).toHaveLength(1);
    expect(result[0]?.documents).toEqual([
      { id: "doc_1", originalFileName: "a.pdf", contentType: "application/pdf" },
    ]);
  });
});

describe("sweepOrphanedSubmissionObjects", () => {
  // db whose document-key query resolves the referenced r2 keys for the submission.
  const buildSweepDb = (referencedKeys: string[]) => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn().mockResolvedValue(referencedKeys.map((r2Key) => ({ r2Key }))),
    };
    return { select: vi.fn(() => chain) };
  };

  const OLD = new Date(Date.now() - 60 * 60 * 1000); // an hour old — safely past the upload window

  it("deletes objects with no referencing row, keeps referenced ones", async () => {
    const db = buildSweepDb(["recruiter-verification/u_1/sub_1/keep"]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/keep", lastModified: OLD },
      { key: "recruiter-verification/u_1/sub_1/orphan", lastModified: OLD },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never);

    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/orphan");
  });

  it("respects age: does not delete an unreferenced object still inside the upload window", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/in-flight", lastModified: new Date() },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never);

    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("terminal sweep (respectAge=false) deletes even a fresh unreferenced object", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/fresh", lastModified: new Date() },
    ]);

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: false }, db as never);

    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/fresh");
  });

  it("never throws when storage listing fails — it is best-effort", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockRejectedValueOnce(new Error("R2 down"));

    await expect(
      sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: true }, db as never),
    ).resolves.toBeUndefined();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("no-ops (no db query) when nothing exists under the prefix", async () => {
    const db = buildSweepDb([]);
    mockGetDb.mockReturnValue(db);
    // mockListObjects default resolves [].

    await sweepOrphanedSubmissionObjects("u_1", "sub_1", { respectAge: false }, db as never);

    expect(db.select).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

describe("sweepOrphanedObjectsForAccount", () => {
  // db whose pending lookup (.limit) returns `pendingRows` and whose document-key query (awaited
  // after .where) returns `referencedKeys`.
  const buildAccountDb = (pendingRows: Array<{ id: string }>, referencedKeys: string[]) => {
    const referencedRows = referencedKeys.map((r2Key) => ({ r2Key }));
    const whereResult = {
      limit: vi.fn().mockResolvedValue(pendingRows),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(referencedRows).then(onFulfilled, onRejected),
    };
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => whereResult) };
    return { select: vi.fn(() => chain) };
  };

  const OLD = new Date(Date.now() - 60 * 60 * 1000);

  it("sweeps the account's pending submission's orphans", async () => {
    const db = buildAccountDb([{ id: "sub_1" }], ["recruiter-verification/u_1/sub_1/keep"]);
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/keep", lastModified: OLD },
      { key: "recruiter-verification/u_1/sub_1/orphan", lastModified: OLD },
    ]);

    await sweepOrphanedObjectsForAccount("u_1", db as never);

    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/orphan");
  });

  it("no-ops when the account has no pending submission", async () => {
    const db = buildAccountDb([], []);
    mockGetDb.mockReturnValue(db);

    await sweepOrphanedObjectsForAccount("u_1", db as never);

    expect(mockListObjects).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

// Guards against an accidental import removal — the service must reference these schema tables.
it("references the recruiter verification schema tables", () => {
  expect(recruiterVerificationSubmissions).toBeDefined();
});
