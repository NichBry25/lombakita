// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn(() => true),
  generatePresignedPutUrl: vi.fn(async (key: string) => `https://r2.example.com/${key}?presigned=1`),
}));
vi.mock("@/server/institution-verification/verification-email", () => ({
  sendInstitutionVerifiedEmail: vi.fn(async () => {}),
}));

import {
  createVerificationSubmission,
  reviewVerificationSubmission,
  SubmissionError,
  type DocumentInput,
} from "./submission-service";
import { RecruiterTierError } from "@/server/auth/recruiter-tier";
import { InstitutionTypeTransitionError } from "@/server/institution-workspace/institution-type";
import { MAX_INSTITUTIONS_PER_RECRUITER } from "@/server/institution-workspace/institution-core";
import { isR2Available } from "@/server/storage/r2.client";

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.innerJoin = () => c;
  c.leftJoin = () => c;
  c.where = () => c;
  c.limit = () => Promise.resolve(result);
  c.orderBy = () => c;
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

function updateChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.set = () => c;
  c.where = () => c;
  c.returning = () => Promise.resolve(result);
  return c;
}

function insertChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.values = () => c;
  c.returning = () => Promise.resolve(result);
  return c;
}

type DbMockOpts = {
  selects?: unknown[][];
  updates?: unknown[][];
  inserts?: unknown[][];
};

function createDbMock(opts: DbMockOpts) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const inserts = [...(opts.inserts ?? [])];

  const db: Record<string, unknown> = {
    select: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? []),
    insert: () => insertChain(inserts.shift() ?? []),
    // The approval path acquires a per-owner advisory lock (tx.execute) before the full-count. A
    // no-op keeps every non-upgrade test unaffected; the concurrency describe below drives it directly.
    execute: () => Promise.resolve([]),
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db as never;
}

const catchAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

// ─── createVerificationSubmission ─────────────────────────────────────────────

describe("createVerificationSubmission", () => {
  afterEach(() => vi.restoreAllMocks());

  // Fixture: institution_owner membership row
  const ownerRow = {
    institutionId: "inst_1",
    institutionType: "personal",
    membershipId: "mem_1",
  };

  // Fixture: presigned upload result per document
  const submissionRow = { id: "sub_1" };

  it("happy path — personal institution submitting KTP", async () => {
    const db = createDbMock({
      selects: [[ownerRow]], // resolveOwnerInstitution
      inserts: [
        [submissionRow], // institutionVerificationSubmissions insert
        [],              // institutionVerificationDocuments insert
      ],
    });

    const docs: DocumentInput[] = [
      {
        documentType: "ktp",
        originalFileName: "ktp.jpg",
        fileSizeBytes: 200_000,
        contentType: "image/jpeg",
      },
    ];

    const result = await createVerificationSubmission(
      "alice",
      "personal",
      null,
      docs,
      "user_1",
      db,
    );

    expect(result.submissionId).toBe("sub_1");
    expect(result.documents).toHaveLength(1);
    const firstDoc = result.documents[0]!;
    expect(firstDoc.documentType).toBe("ktp");
    expect(firstDoc.uploadUrl).toContain("presigned=1");
  });

  it("returns 503 when R2 is unavailable", async () => {
    vi.mocked(isR2Available).mockReturnValueOnce(false);
    const err = await catchAsync(() =>
      createVerificationSubmission("alice", "personal", null, [], "user_1", createDbMock({})),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("verification_storage_unavailable");
    expect((err as SubmissionError).status).toBe(503);
  });

  it("returns 404 when institution not found or actor is not owner", async () => {
    const db = createDbMock({ selects: [[]] }); // empty result = not found
    const err = await catchAsync(() =>
      createVerificationSubmission("no-such-slug", "personal", null, [], "user_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_not_found");
    expect((err as SubmissionError).status).toBe(404);
  });

  it("returns 422 when required documents are missing", async () => {
    const db = createDbMock({ selects: [[ownerRow]] });
    const err = await catchAsync(() =>
      createVerificationSubmission(
        "alice",
        "personal",
        null,
        [], // no documents
        "user_1",
        db,
      ),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("missing_required_documents");
    expect((err as SubmissionError).status).toBe(422);
    const details = (err as SubmissionError).details;
    expect((details as { missingDocuments: string[] }).missingDocuments).toContain("ktp");
  });

  it("returns 422 when upgrading from personal without proposedDisplayName", async () => {
    const db = createDbMock({
      selects: [
        [ownerRow], // resolveOwnerInstitution — returns personal type
        [{ recruiterVerifiedAt: new Date(), recruiterVerificationTier: "elevated" }], // tier check
      ],
    });

    const err = await catchAsync(() =>
      createVerificationSubmission(
        "alice",
        "company",
        null, // no display name
        [
          { documentType: "npwp", originalFileName: "npwp.pdf", fileSizeBytes: 100_000, contentType: "application/pdf" },
          { documentType: "nib", originalFileName: "nib.pdf", fileSizeBytes: 80_000, contentType: "application/pdf" },
        ],
        "user_1",
        db,
      ),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("proposed_display_name_required");
    expect((err as SubmissionError).status).toBe(422);
  });

  it("returns tier error when upgrading from personal without elevated tier", async () => {
    const db = createDbMock({
      selects: [
        [ownerRow], // resolveOwnerInstitution — personal type
        // getRecruiterTierForAccount returns minimal (not elevated)
        [{ recruiterVerifiedAt: new Date(), recruiterVerificationTier: "minimal" }],
      ],
    });

    const err = await catchAsync(() =>
      createVerificationSubmission(
        "alice",
        "company",
        "PT Alice Corp",
        [
          { documentType: "npwp", originalFileName: "npwp.pdf", fileSizeBytes: 100_000, contentType: "application/pdf" },
          { documentType: "nib", originalFileName: "nib.pdf", fileSizeBytes: 80_000, contentType: "application/pdf" },
        ],
        "user_1",
        db,
      ),
    );
    expect(err).toBeInstanceOf(RecruiterTierError);
    expect((err as RecruiterTierError).code).toBe("recruiter_tier_insufficient");
    expect((err as RecruiterTierError).status).toBe(403);
  });

  it("throws InstitutionTypeTransitionError for an illegal type transition", async () => {
    // company → personal is forbidden per the state machine
    const companyOwnerRow = { ...ownerRow, institutionType: "company" };
    const db = createDbMock({ selects: [[companyOwnerRow]] });

    const err = await catchAsync(() =>
      createVerificationSubmission(
        "alice",
        "personal",
        null,
        [{ documentType: "ktp", originalFileName: "ktp.jpg", fileSizeBytes: 200_000, contentType: "image/jpeg" }],
        "user_1",
        db,
      ),
    );
    expect(err).toBeInstanceOf(InstitutionTypeTransitionError);
  });
});

// ─── reviewVerificationSubmission ─────────────────────────────────────────────

describe("reviewVerificationSubmission", () => {
  afterEach(() => vi.restoreAllMocks());

  const pendingSub = {
    id: "sub_1",
    institutionId: "inst_1",
    targetInstitutionType: "personal",
    proposedDisplayName: null,
    status: "pending_review",
    submittedByUserId: "user_1",
  };

  const upgradeSub = {
    id: "sub_2",
    institutionId: "inst_1",
    targetInstitutionType: "company",
    proposedDisplayName: "PT Alice Corp",
    status: "pending_review",
    submittedByUserId: "user_1",
  };

  const personalInst = {
    id: "inst_1",
    displayName: null,
    institutionType: "personal",
    verificationStatus: "pending_verification",
    slug: "alice",
  };

  const ownerMembership = { email: "alice@gmail.com", username: "alice" };

  it("returns 403 when actor is not platform_ops", async () => {
    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", "recruiter", createDbMock({})),
    );
    expect((err as { status: number }).status).toBe(403);
  });

  it("reject — marks submission rejected with audit row, no institution status change", async () => {
    const db = createDbMock({
      selects: [
        [pendingSub], // CAS fetch submission
        [personalInst], // fetch institution
      ],
      updates: [
        [{ id: "sub_1", status: "rejected" }], // submission update
      ],
      inserts: [
        [{ id: "audit_1" }], // audit row (same fromStatus → toStatus; rejection does not flip institution status)
      ],
    });

    const result = await reviewVerificationSubmission(
      "sub_1",
      "rejected",
      "Dokumen tidak valid",
      "ops_1",
      "platform_ops",
      db,
    );

    expect(result.submissionId).toBe("sub_1");
    expect(result.status).toBe("rejected");
  });

  it("approve regular verification (personal → personal) — sets verifiedAt, writes audit, marks approved", async () => {
    const db = createDbMock({
      selects: [
        [pendingSub],  // CAS fetch submission
        [personalInst], // fetch institution
        [ownerMembership], // post-commit email lookup
      ],
      updates: [
        [{ id: "inst_1", verificationStatus: "verified" }], // institution update
        [{ id: "sub_1", status: "approved" }],              // submission update
      ],
      inserts: [
        [{ id: "audit_1" }], // institutionVerificationAudit insert
      ],
    });

    const result = await reviewVerificationSubmission(
      "sub_1",
      "approved",
      null,
      "ops_1",
      "platform_ops",
      db,
    );

    expect(result.submissionId).toBe("sub_1");
    expect(result.status).toBe("approved");
  });

  it("approve upgrade (personal → company) — type flip + display_name + verifiedAt in one transaction", async () => {
    const elevatedTierUser = {
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    };
    const db = createDbMock({
      selects: [
        [upgradeSub],                    // CAS fetch submission (status=pending_review)
        [personalInst],                  // fetch institution (type=personal)
        [elevatedTierUser],              // tier check for submitter (outer db call)
        [{ userId: "user_1" }],          // owner membership lookup for limit check
        [{ value: 0 }],                  // count of existing full institutions (0 → no breach)
        [ownerMembership],               // post-commit email lookup
      ],
      updates: [
        [{ id: "inst_1", institutionType: "company", displayName: "PT Alice Corp", verificationStatus: "verified" }],
        [{ id: "sub_2", status: "approved" }],
      ],
      inserts: [
        [{ id: "audit_1" }],
      ],
    });

    const result = await reviewVerificationSubmission(
      "sub_2",
      "approved",
      null,
      "ops_1",
      "platform_ops",
      db,
    );

    expect(result.status).toBe("approved");
  });

  it("D1 — upgrade blocked when recruiter would exceed full-institution limit", async () => {
    const elevatedTierUser = {
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    };
    const db = createDbMock({
      selects: [
        [upgradeSub],           // CAS fetch submission
        [personalInst],         // fetch institution
        [elevatedTierUser],     // tier check
        [{ userId: "user_1" }], // owner membership lookup
        [{ value: 3 }],         // count = 3 (MAX); existingFullCount + 1 = 4 > 3 → block
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_2", "approved", null, "ops_1", "platform_ops", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_upgrade_limit_reached");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("D2 — upgrade blocked when submittedByUserId is NULL (deleted account)", async () => {
    const deletedSubmitterSub = { ...upgradeSub, submittedByUserId: null };
    const db = createDbMock({
      selects: [
        [deletedSubmitterSub], // CAS fetch submission — submittedByUserId is null
        [personalInst],        // fetch institution
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_2", "approved", null, "ops_1", "platform_ops", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("submitter_account_deleted");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("CAS guard — double-review rejected (already approved)", async () => {
    const alreadyApproved = { ...pendingSub, status: "approved" };
    const db = createDbMock({
      selects: [
        [alreadyApproved], // CAS fetch — status is not pending_review
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", "platform_ops", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("submission_already_reviewed");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("returns 404 when submission not found", async () => {
    const db = createDbMock({ selects: [[]] }); // empty result
    const err = await catchAsync(() =>
      reviewVerificationSubmission("no-sub", "approved", null, "ops_1", "platform_ops", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("submission_not_found");
    expect((err as SubmissionError).status).toBe(404);
  });
});

// ─── Route-level access gates ─────────────────────────────────────────────────

describe("reviewVerificationSubmission — platform_ops gate", () => {
  it("throws 403 for any role other than platform_ops", async () => {
    for (const role of ["recruiter", "candidate", "finance_ops", "reviewer_or_judge"]) {
      const err = await catchAsync(() =>
        reviewVerificationSubmission("sub_1", "approved", null, "user_1", role, createDbMock({})),
      );
      expect((err as { status: number }).status).toBe(403);
    }
  });
});

describe("createVerificationSubmission — institution-owner gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 404 (non-leaking) when actor has no active owner membership", async () => {
    // resolveOwnerInstitution returns [] when no ownership row found
    const db = createDbMock({ selects: [[]] });
    const err = await catchAsync(() =>
      createVerificationSubmission("alice", "personal", null, [], "imposter_id", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_not_found");
    // non-leaking: returns 404, not 403, so the route does not confirm slug existence
    expect((err as SubmissionError).status).toBe(404);
  });
});

// ─── owner-cap lock on the upgrade-approval path (concurrency hardening) ────────
// Two platform-ops approvals of two different pending upgrade submissions owned by the same recruiter
// each snapshot a full-count blind to the other's uncommitted type-flip under READ COMMITTED. The
// per-owner advisory lock (acquired before the count) serializes them so the second re-counts the
// first's committed flip and trips the existing 409. The harness cannot run true parallel
// transactions, so these assert the atomic guard directly: the lock is acquired keyed on the owner,
// before the count, and the at-cap in-tx count maps to institution_upgrade_limit_reached.
describe("reviewVerificationSubmission — owner-cap lock (concurrency)", () => {
  afterEach(() => vi.restoreAllMocks());

  const upgradeSub = {
    id: "sub_2",
    institutionId: "inst_1",
    targetInstitutionType: "company",
    proposedDisplayName: "PT Alice Corp",
    status: "pending_review",
    submittedByUserId: "user_1",
  };
  const personalInst = {
    id: "inst_1",
    displayName: null,
    institutionType: "personal",
    verificationStatus: "pending_verification",
    slug: "alice",
  };
  const elevated = { recruiterVerifiedAt: new Date(), recruiterVerificationTier: "elevated" };

  const extractLockKey = (query: unknown): string | undefined => {
    // drizzle stores an interpolated raw string as a primitive string chunk (parameterized at build
    // time), not a Param object — so match the chunk that IS the "inst_owner_cap:<userId>" string.
    const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
    return chunks.find(
      (c): c is string => typeof c === "string" && c.startsWith("inst_owner_cap:"),
    );
  };

  const makeApprovalLockDb = (opts: { ownerUserId: string; inTxFullCount: number }) => {
    const lockKeys: string[] = [];
    const order: string[] = [];
    const selects: unknown[][] = [
      [upgradeSub], // CAS fetch submission
      [personalInst], // fetch institution
      [elevated], // submitter tier check
      [{ userId: opts.ownerUserId }], // active-owner lookup (lock key source)
      [{ value: opts.inTxFullCount }], // full-institution count (under the lock)
      [{ email: "alice@gmail.com", username: "alice" }], // post-commit email
    ];
    let sel = 0;
    const db: Record<string, unknown> = {
      select: () => {
        order.push("select");
        return selectChain(selects[sel++] ?? []);
      },
      update: () => {
        order.push("update");
        return updateChain([{ id: "inst_1" }]);
      },
      insert: () => insertChain([{ id: "audit_1" }]),
      execute: (q: unknown) => {
        order.push("execute");
        const key = extractLockKey(q);
        if (key) lockKeys.push(key);
        return Promise.resolve([]);
      },
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
    return { db: db as never, lockKeys, order };
  };

  it("locks on the owner before the count, and the at-cap in-tx count trips institution_upgrade_limit_reached", async () => {
    const { db, lockKeys, order } = makeApprovalLockDb({
      ownerUserId: "owner_1",
      inTxFullCount: MAX_INSTITUTIONS_PER_RECRUITER, // already at cap → +1 exceeds → block
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_2", "approved", null, "ops_1", "platform_ops", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_upgrade_limit_reached");
    expect((err as SubmissionError).status).toBe(409);

    // The lock was acquired exactly once, keyed on the resolved owner.
    expect(lockKeys).toEqual(["inst_owner_cap:owner_1"]);

    // Ordering: owner resolution (4 selects) → lock → count select. The count runs under the lock.
    const execIdx = order.indexOf("execute");
    expect(order.slice(0, execIdx)).toEqual(["select", "select", "select", "select"]);
    expect(order[execIdx + 1]).toBe("select");
  });

  it("cross-owner independence: approvals for two different owners acquire distinct lock keys", async () => {
    const a = makeApprovalLockDb({ ownerUserId: "owner_A", inTxFullCount: 0 });
    const b = makeApprovalLockDb({ ownerUserId: "owner_B", inTxFullCount: 0 });

    await reviewVerificationSubmission("sub_2", "approved", null, "ops_1", "platform_ops", a.db);
    await reviewVerificationSubmission("sub_2", "approved", null, "ops_1", "platform_ops", b.db);

    expect(a.lockKeys).toEqual(["inst_owner_cap:owner_A"]);
    expect(b.lockKeys).toEqual(["inst_owner_cap:owner_B"]);
    // Distinct keys → owner A's lock can never block owner B's approval.
    expect(a.lockKeys[0]).not.toBe(b.lockKeys[0]);
  });
});
