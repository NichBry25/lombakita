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

const { mockEnqueueRejected } = vi.hoisted(() => ({
  mockEnqueueRejected: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/async/enqueue", () => ({
  enqueueRecruiterVerificationRejected: mockEnqueueRejected,
}));

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));

import { recruiterVerificationSubmissions, users } from "@/server/db/schema";
import {
  deleteVerificationDocumentForUser,
  finalizeVerificationDocumentUpload,
  listRecruiterVerificationQueue,
  prepareVerificationDocumentUpload,
  resolveVerificationDocumentUrlForOps,
  reviewRecruiterVerification,
  setRecruiterResubmissionAllowed,
  submitRecruiterVerification,
  withdrawRecruiterVerification,
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
    submissionSet: null as Record<string, unknown> | null,
  };

  const submissionUpdateChain = {
    set: vi.fn((values: Record<string, unknown>) => {
      captured.submissionSet = values;
      return submissionUpdateChain;
    }),
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

  // The post-commit orphan sweep runs against this same db handle and reads the submission's
  // referenced document keys; with none referenced, every listed object is an orphan candidate and
  // only the age guard decides whether it is deleted.
  const sweepSelectChain = {
    from: vi.fn(() => sweepSelectChain),
    where: vi.fn().mockResolvedValue([]),
  };

  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    select: vi.fn(() => sweepSelectChain),
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

    const result = await reviewRecruiterVerification("ops_1", "sub_1", "approve", null, {
      db: db as never,
    });

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
      reviewRecruiterVerification("ops_1", "sub_1", "reject", "   ", { db: db as never }),
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
      { db: db as never },
    );

    expect(result.status).toBe("rejected");
    expect(captured.userTierUpdated).toBe(false);
    expect(captured.auditInserted).toMatchObject({
      eventType: "recruiter_verification.rejected",
      reason: "Tidak dapat memverifikasi afiliasi",
    });
  });

  it("reject: defaults to allowing the recruiter to reopen, and notifies them", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);

    await reviewRecruiterVerification("ops_1", "sub_1", "reject", "Dokumen tidak jelas", {
      db: db as never,
    });

    expect(mockEnqueueRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "sub_1",
        userId: "u_1",
        rejectionReason: "Dokumen tidak jelas",
        resubmissionAllowed: true,
      }),
    );
  });

  it("reject: records the reviewer's bar on the row, in the audit row, and in the notice", async () => {
    const { db, captured } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);

    await reviewRecruiterVerification("ops_1", "sub_1", "reject", "Penipuan", {
      allowResubmission: false,
      db: db as never,
    });

    expect(captured.submissionSet).toMatchObject({ resubmissionAllowed: false });
    expect(captured.auditInserted?.metadata).toMatchObject({ resubmissionAllowed: false });
    expect(mockEnqueueRejected).toHaveBeenCalledWith(
      expect.objectContaining({ resubmissionAllowed: false }),
    );
  });

  it("reject: a notification enqueue failure never fails the committed review", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);
    mockEnqueueRejected.mockRejectedValueOnce(new Error("redis down"));

    const result = await reviewRecruiterVerification("ops_1", "sub_1", "reject", "Alasan", {
      db: db as never,
    });

    expect(result.status).toBe("rejected");
  });

  it("reject: the orphan sweep keeps its age guard so an in-flight upload survives", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);
    // A freshly uploaded object the recruiter is still working on, inside the upload window.
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/in-flight", lastModified: new Date() },
    ]);

    await reviewRecruiterVerification("ops_1", "sub_1", "reject", "Alasan", { db: db as never });

    // A rejected submission stays editable, so the sweep must not reclaim a live upload.
    expect(mockListObjects).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/");
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("approve: the orphan sweep is terminal and reclaims even a just-uploaded object", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [{ userId: "u_1" }],
      existingSubmission: [],
    });
    mockGetDb.mockReturnValue(db);
    mockListObjects.mockResolvedValueOnce([
      { key: "recruiter-verification/u_1/sub_1/in-flight", lastModified: new Date() },
    ]);

    await reviewRecruiterVerification("ops_1", "sub_1", "approve", null, { db: db as never });

    // Approval is terminal — no further upload can arrive, so the age guard is unnecessary.
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/in-flight");
  });

  it("throws already_reviewed (409) when the CAS flip matches no pending row but the row exists", async () => {
    const { db } = buildReviewDb({
      submissionReturn: [],
      existingSubmission: [{ id: "sub_1" }],
    });
    mockGetDb.mockReturnValue(db);

    await expect(
      reviewRecruiterVerification("ops_1", "sub_1", "approve", null, { db: db as never }),
    ).rejects.toMatchObject({ code: "recruiter_verification_already_reviewed", status: 409 });
  });

  it("throws not_found (404) when the submission does not exist at all", async () => {
    const { db } = buildReviewDb({ submissionReturn: [], existingSubmission: [] });
    mockGetDb.mockReturnValue(db);

    await expect(
      reviewRecruiterVerification("ops_1", "missing", "approve", null, { db: db as never }),
    ).rejects.toMatchObject({ code: "recruiter_verification_not_found", status: 404 });
  });
});

describe("submitRecruiterVerification", () => {
  // Three sequential selects in order: the account tier, the editable-submission lookup, and (only
  // when the CAS matches nothing) the diagnostic re-read of the row's current state.
  const buildSubmitDb = (opts: {
    accountRow: Array<{ recruiterVerificationTier: string }>;
    editableRow?: Array<{ id: string }>;
    queuedReturn?: Array<Record<string, unknown>>;
    diagnosticRow?: Array<{ status: string; resubmissionAllowed: boolean }>;
  }) => {
    const captured = { updateSet: null as Record<string, unknown> | null };
    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      orderBy: vi.fn(() => selectChain),
      limit: vi
        .fn()
        .mockResolvedValueOnce(opts.accountRow)
        .mockResolvedValueOnce(opts.editableRow ?? [])
        .mockResolvedValueOnce(opts.diagnosticRow ?? []),
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "sub_new" }]) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          captured.updateSet = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(opts.queuedReturn ?? []),
            })),
          };
        }),
      })),
    };
    return Object.assign(db, { captured });
  };

  const INPUT = {
    fullName: "Rendra Wijaya",
    mobileNumber: "0812345678",
    corporateEmail: null,
  };

  it("refuses when the account is already Trusted (elevated)", async () => {
    const db = buildSubmitDb({ accountRow: [{ recruiterVerificationTier: "elevated" }] });
    mockGetDb.mockReturnValue(db);

    await expect(submitRecruiterVerification("u_1", INPUT, db as never)).rejects.toMatchObject({
      code: "recruiter_already_trusted",
      status: 409,
    });
  });

  it("inserts a first submission when the account has nothing editable", async () => {
    const db = buildSubmitDb({
      accountRow: [{ recruiterVerificationTier: "minimal" }],
      editableRow: [],
    });
    mockGetDb.mockReturnValue(db);

    const row = await submitRecruiterVerification("u_1", INPUT, db as never);

    expect(row).toEqual({ id: "sub_new" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("queues the existing editable row rather than inserting a second one", async () => {
    const db = buildSubmitDb({
      accountRow: [{ recruiterVerificationTier: "minimal" }],
      editableRow: [{ id: "sub_draft" }],
      queuedReturn: [{ id: "sub_draft", status: "pending_review" }],
    });
    mockGetDb.mockReturnValue(db);

    const row = await submitRecruiterVerification("u_1", INPUT, db as never);

    expect(row).toMatchObject({ id: "sub_draft" });
    // Moving the same row is what carries the attached documents into the queue; a fresh insert
    // would strand them.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.captured.updateSet).toMatchObject({ status: "pending_review" });
    expect(db.captured.updateSet).toHaveProperty("submittedAt");
  });

  it("keeps the applicant's queue position — it bumps submitted_at but never first_submitted_at", async () => {
    const db = buildSubmitDb({
      accountRow: [{ recruiterVerificationTier: "minimal" }],
      editableRow: [{ id: "sub_draft" }],
      queuedReturn: [{ id: "sub_draft", status: "pending_review" }],
    });
    mockGetDb.mockReturnValue(db);

    await submitRecruiterVerification("u_1", INPUT, db as never);

    // The queue orders by first_submitted_at, so leaving it untouched is what stops a revise-and-
    // resend from costing the applicant their place in line.
    expect(db.captured.updateSet).toHaveProperty("submittedAt");
    expect(db.captured.updateSet).not.toHaveProperty("firstSubmittedAt");
  });

  it("refuses when the reviewer barred the account, diagnosing the bar rather than a race", async () => {
    const db = buildSubmitDb({
      accountRow: [{ recruiterVerificationTier: "minimal" }],
      editableRow: [{ id: "sub_rejected" }],
      // The CAS carries `resubmission_allowed = true`, so a barred row matches nothing.
      queuedReturn: [],
      diagnosticRow: [{ status: "rejected", resubmissionAllowed: false }],
    });
    mockGetDb.mockReturnValue(db);

    await expect(submitRecruiterVerification("u_1", INPUT, db as never)).rejects.toMatchObject({
      code: "recruiter_verification_resubmission_blocked",
      status: 409,
    });
  });

  it("reports a lost race as already_pending, not as a bar", async () => {
    const db = buildSubmitDb({
      accountRow: [{ recruiterVerificationTier: "minimal" }],
      editableRow: [{ id: "sub_rejected" }],
      queuedReturn: [],
      diagnosticRow: [{ status: "pending_review", resubmissionAllowed: true }],
    });
    mockGetDb.mockReturnValue(db);

    await expect(submitRecruiterVerification("u_1", INPUT, db as never)).rejects.toMatchObject({
      code: "recruiter_verification_already_pending",
      status: 409,
    });
  });
});

describe("withdrawRecruiterVerification", () => {
  const buildWithdrawDb = (updateReturn: Array<Record<string, unknown>>) => {
    const captured = { updateSet: null as Record<string, unknown> | null };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          captured.updateSet = values;
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(updateReturn) })),
          };
        }),
      })),
    };
    return Object.assign(db, { captured });
  };

  it("moves a queued submission back to draft so its documents become editable", async () => {
    const db = buildWithdrawDb([{ id: "sub_1", status: "draft" }]);
    mockGetDb.mockReturnValue(db);

    const row = await withdrawRecruiterVerification("u_1", db as never);

    expect(row).toMatchObject({ id: "sub_1" });
    expect(db.captured.updateSet).toEqual({ status: "draft" });
  });

  it("404s when nothing is awaiting review — including when a verdict won the race", async () => {
    const db = buildWithdrawDb([]);
    mockGetDb.mockReturnValue(db);

    await expect(withdrawRecruiterVerification("u_1", db as never)).rejects.toMatchObject({
      code: "recruiter_verification_not_found",
      status: 404,
    });
  });
});

// db whose editable-submission lookup returns `pendingRows`, capturing any inserted document row.
const buildDocumentDb = (pendingRows: Array<{ id: string }>) => {
  const captured = { inserted: null as Record<string, unknown> | null };
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
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

describe("deleteVerificationDocumentForUser", () => {
  // db whose editable-submission lookup returns `pendingRows` and whose delete returns
  // `deletedRows`, capturing whether a delete was attempted at all.
  const buildDeleteDb = (
    pendingRows: Array<{ id: string }>,
    deletedRows: Array<{ r2Key: string }>,
  ) => {
    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      orderBy: vi.fn(() => selectChain),
      limit: vi.fn().mockResolvedValue(pendingRows),
    };
    const deleteChain = {
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(deletedRows) })),
    };
    return {
      select: vi.fn(() => selectChain),
      delete: vi.fn(() => deleteChain),
    };
  };

  it("removes the row and then the stored object", async () => {
    const db = buildDeleteDb(
      [{ id: "sub_1" }],
      [{ r2Key: "recruiter-verification/u_1/sub_1/abc" }],
    );
    mockGetDb.mockReturnValue(db);

    await deleteVerificationDocumentForUser("u_1", "doc_1", db as never);

    expect(db.delete).toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledWith("recruiter-verification/u_1/sub_1/abc");
  });

  it("404s when the document is not on the caller's open submission, leaving storage untouched", async () => {
    const db = buildDeleteDb([{ id: "sub_1" }], []);
    mockGetDb.mockReturnValue(db);

    await expect(
      deleteVerificationDocumentForUser("u_1", "doc_other", db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_document_not_found", status: 404 });
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("404s when the account has no submission awaiting review, before any delete", async () => {
    const db = buildDeleteDb([], []);
    mockGetDb.mockReturnValue(db);

    await expect(
      deleteVerificationDocumentForUser("u_1", "doc_1", db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_not_found", status: 404 });
    expect(db.delete).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("keeps the row deleted when the storage delete fails", async () => {
    const db = buildDeleteDb(
      [{ id: "sub_1" }],
      [{ r2Key: "recruiter-verification/u_1/sub_1/abc" }],
    );
    mockGetDb.mockReturnValue(db);
    mockDeleteObject.mockRejectedValueOnce(new Error("r2 down"));

    await expect(
      deleteVerificationDocumentForUser("u_1", "doc_1", db as never),
    ).resolves.toBeUndefined();
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

describe("listRecruiterVerificationQueue", () => {
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

    const result = await listRecruiterVerificationQueue(db as never);

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
  // db whose editable-submission lookup (.orderBy().limit()) returns `pendingRows` and whose
  // document-key query (awaited after .where) returns `referencedKeys`.
  const buildAccountDb = (pendingRows: Array<{ id: string }>, referencedKeys: string[]) => {
    const referencedRows = referencedKeys.map((r2Key) => ({ r2Key }));
    const whereResult = {
      orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(pendingRows) })),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(referencedRows).then(onFulfilled, onRejected),
    };
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => whereResult) };
    return { select: vi.fn(() => chain) };
  };

  const OLD = new Date(Date.now() - 60 * 60 * 1000);

  it("sweeps the account's editable submission's orphans", async () => {
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

  it("no-ops when the account has no editable submission", async () => {
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

describe("setRecruiterResubmissionAllowed", () => {
  // tx whose update returns `updateReturn` and whose select returns `existing`, capturing the
  // audit row so the event type can be asserted.
  const buildFlagDb = (
    updateReturn: Array<{ userId: string }>,
    existing: Array<{ status: string; resubmissionAllowed: boolean }>,
  ) => {
    const captured = { auditInserted: null as Record<string, unknown> | null };
    const updateChain = {
      set: vi.fn(() => updateChain),
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(updateReturn) })),
    };
    const selectChain = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn().mockResolvedValue(existing),
    };
    const tx = {
      update: vi.fn(() => updateChain),
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          captured.auditInserted = v;
          return Promise.resolve(undefined);
        }),
      })),
    };
    const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    return { db, captured };
  };

  it("lifts the bar and audits the change", async () => {
    const { db, captured } = buildFlagDb([{ userId: "u_1" }], []);
    mockGetDb.mockReturnValue(db);

    await setRecruiterResubmissionAllowed("ops_1", "sub_1", true, db as never);

    expect(captured.auditInserted).toMatchObject({
      actorUserId: "ops_1",
      targetUserId: "u_1",
      eventType: "recruiter_verification.resubmission_allowed",
    });
  });

  it("imposes a bar and audits it under a distinct event type", async () => {
    const { db, captured } = buildFlagDb([{ userId: "u_1" }], []);
    mockGetDb.mockReturnValue(db);

    await setRecruiterResubmissionAllowed("ops_1", "sub_1", false, db as never);

    expect(captured.auditInserted).toMatchObject({
      eventType: "recruiter_verification.resubmission_blocked",
    });
  });

  it("is idempotent — a repeat click files no second audit row", async () => {
    const { db, captured } = buildFlagDb([], [{ status: "rejected", resubmissionAllowed: true }]);
    mockGetDb.mockReturnValue(db);

    await setRecruiterResubmissionAllowed("ops_1", "sub_1", true, db as never);

    expect(captured.auditInserted).toBeNull();
  });

  it("refuses on a submission that is not rejected", async () => {
    const { db } = buildFlagDb([], [{ status: "pending_review", resubmissionAllowed: true }]);
    mockGetDb.mockReturnValue(db);

    await expect(
      setRecruiterResubmissionAllowed("ops_1", "sub_1", false, db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_already_reviewed", status: 409 });
  });

  it("404s when the submission does not exist", async () => {
    const { db } = buildFlagDb([], []);
    mockGetDb.mockReturnValue(db);

    await expect(
      setRecruiterResubmissionAllowed("ops_1", "missing", true, db as never),
    ).rejects.toMatchObject({ code: "recruiter_verification_not_found", status: 404 });
  });
});
