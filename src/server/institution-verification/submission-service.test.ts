// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn(() => true),
  generatePresignedPutUrl: vi.fn(
    async (key: string) => `https://r2.example.com/${key}?presigned=1`,
  ),
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

function updateChain(result: unknown[], onSet?: (payload: Record<string, unknown>) => void) {
  const c: Record<string, unknown> = {};
  c.set = (payload: Record<string, unknown>) => {
    onSet?.(payload);
    return c;
  };
  c.where = () => c;
  c.returning = () => Promise.resolve(result);
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

function insertChain(result: unknown[], onValues?: (payload: Record<string, unknown>) => void) {
  const c: Record<string, unknown> = {};
  c.values = (payload: Record<string, unknown>) => {
    onValues?.(payload);
    return c;
  };
  c.returning = () => Promise.resolve(result);
  return c;
}

type DbMockOpts = {
  selects?: unknown[][];
  updates?: unknown[][];
  inserts?: unknown[][];
  // Receives every .set() payload the code under test writes, in call order.
  onSet?: (payload: Record<string, unknown>) => void;
  // Receives every .values() payload passed to an insert, in call order.
  onInsertValues?: (payload: Record<string, unknown>) => void;
};

function createDbMock(opts: DbMockOpts) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const inserts = [...(opts.inserts ?? [])];

  const db: Record<string, unknown> = {
    select: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? [], opts.onSet),
    insert: () => insertChain(inserts.shift() ?? [], opts.onInsertValues),
    // Harmless no-op: no path under test issues raw SQL any more, but keeping the handle means a
    // future one fails on its assertion rather than on a missing mock method.
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

  // Fixture: institution_owner membership row for a declared full institution.
  const ownerRow = {
    institutionId: "inst_1",
    institutionType: "company",
    membershipId: "mem_1",
  };

  const submissionRow = { id: "sub_1" };

  const companyDocs: DocumentInput[] = [
    {
      documentType: "npwp",
      originalFileName: "npwp.pdf",
      fileSizeBytes: 100_000,
      contentType: "application/pdf",
    },
    {
      documentType: "nib",
      originalFileName: "nib.pdf",
      fileSizeBytes: 80_000,
      contentType: "application/pdf",
    },
  ];

  it("happy path — a full institution submitting its own type's documents", async () => {
    const db = createDbMock({
      selects: [[ownerRow]], // resolveOwnerInstitution
      inserts: [
        [submissionRow], // institutionVerificationSubmissions insert
        [], // institutionVerificationDocuments insert
        [],
      ],
    });

    const result = await createVerificationSubmission("alice", companyDocs, "user_1", db);

    expect(result.submissionId).toBe("sub_1");
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0]!.uploadUrl).toContain("presigned=1");
  });

  it("records the submission against the institution's own type (no client-supplied type)", async () => {
    const setPayloads: Record<string, unknown>[] = [];
    const db = createDbMock({
      selects: [[ownerRow]],
      inserts: [[submissionRow], [], []],
      onInsertValues: (v) => setPayloads.push(v),
    });

    await createVerificationSubmission("alice", companyDocs, "user_1", db);

    // The submission's target_institution_type is the institution's own type — 'company' — derived
    // server-side, never taken from the client.
    const submissionValues = setPayloads.find((v) => "targetInstitutionType" in v);
    expect(submissionValues?.targetInstitutionType).toBe("company");
  });

  it("refuses document verification for a personal institution", async () => {
    const personalOwnerRow = { ...ownerRow, institutionType: "personal" };
    const db = createDbMock({ selects: [[personalOwnerRow]] });

    const err = await catchAsync(() =>
      createVerificationSubmission("alice", companyDocs, "user_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_verification_not_applicable");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("returns 503 when R2 is unavailable", async () => {
    vi.mocked(isR2Available).mockReturnValueOnce(false);
    const err = await catchAsync(() =>
      createVerificationSubmission("alice", [], "user_1", createDbMock({})),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("verification_storage_unavailable");
    expect((err as SubmissionError).status).toBe(503);
  });

  it("returns 404 when institution not found or actor is not owner", async () => {
    const db = createDbMock({ selects: [[]] }); // empty result = not found
    const err = await catchAsync(() =>
      createVerificationSubmission("no-such-slug", [], "user_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_not_found");
    expect((err as SubmissionError).status).toBe(404);
  });

  it("returns 422 when the institution's required documents are missing", async () => {
    const db = createDbMock({ selects: [[ownerRow]] });
    const err = await catchAsync(() => createVerificationSubmission("alice", [], "user_1", db));
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("missing_required_documents");
    expect((err as SubmissionError).status).toBe(422);
    const details = (err as SubmissionError).details;
    expect((details as { missingDocuments: string[] }).missingDocuments).toContain("npwp");
  });
});

// ─── reviewVerificationSubmission ─────────────────────────────────────────────

describe("reviewVerificationSubmission", () => {
  afterEach(() => vi.restoreAllMocks());

  const companySub = {
    id: "sub_1",
    institutionId: "inst_1",
    targetInstitutionType: "company",
    proposedDisplayName: null,
    status: "pending_review",
    submittedByUserId: "user_1",
  };

  const companyInst = {
    id: "inst_1",
    displayName: "PT Alice Corp",
    institutionType: "company",
    verificationStatus: "pending_verification",
    slug: "pt-alice-corp",
  };

  const ownerMembership = { email: "alice@company.co.id", username: "alice" };

  it("returns 403 when actor is not platform_ops", async () => {
    const err = await catchAsync(() =>
      reviewVerificationSubmission(
        "sub_1",
        "approved",
        null,
        "ops_1",
        "recruiter",
        createDbMock({}),
      ),
    );
    expect((err as { status: number }).status).toBe(403);
  });

  it("reject — marks submission rejected with audit row, no institution status change", async () => {
    const db = createDbMock({
      selects: [
        [companySub], // CAS fetch submission
        [companyInst], // fetch institution
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

  it("approve — sets verifiedAt, writes audit, marks approved", async () => {
    const db = createDbMock({
      selects: [
        [companySub], // CAS fetch submission
        [companyInst], // fetch institution
        [ownerMembership], // post-commit email lookup
      ],
      updates: [
        [{ id: "inst_1", verificationStatus: "verified" }], // institution update
        [{ id: "sub_1", status: "approved" }], // submission update
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

  it("approval only transitions verification_status — it never writes institution_type", async () => {
    // The institution's type is fixed at creation; verification proves it, it does not change it.
    const setPayloads: Record<string, unknown>[] = [];
    const db = createDbMock({
      onSet: (payload) => setPayloads.push(payload),
      selects: [[companySub], [companyInst], [ownerMembership]],
      updates: [
        [{ id: "inst_1", verificationStatus: "verified" }],
        [{ id: "sub_1", status: "approved" }],
      ],
      inserts: [[{ id: "audit_1" }]],
    });

    const result = await reviewVerificationSubmission(
      "sub_1",
      "approved",
      null,
      "ops_1",
      "platform_ops",
      db,
    );

    expect(result.status).toBe("approved");
    expect(setPayloads.some((payload) => "institutionType" in payload)).toBe(false);
    // And it still verified.
    expect(setPayloads[0]).toMatchObject({ verificationStatus: "verified" });
  });

  it("CAS guard — double-review rejected (already approved)", async () => {
    const alreadyApproved = { ...companySub, status: "approved" };
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
      createVerificationSubmission("alice", [], "imposter_id", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_not_found");
    // non-leaking: returns 404, not 403, so the route does not confirm slug existence
    expect((err as SubmissionError).status).toBe(404);
  });
});
