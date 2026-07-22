// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn().mockReturnValue(true),
  generatePresignedPutUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));

import { recruiterVerificationSubmissions, users } from "@/server/db/schema";
import {
  reviewRecruiterVerification,
  submitRecruiterVerification,
} from "./recruiter-verification-service";
import { RecruiterVerificationError } from "./recruiter-verification-core";

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

// Guards against an accidental import removal — the service must reference these schema tables.
it("references the recruiter verification schema tables", () => {
  expect(recruiterVerificationSubmissions).toBeDefined();
});
