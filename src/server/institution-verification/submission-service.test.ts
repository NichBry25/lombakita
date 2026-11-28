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
vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, enqueueInstitutionTickNotice: vi.fn(async () => ({})) };
});

import {
  createInstagramTickRequest,
  createVerificationSubmission,
  reviewVerificationSubmission,
  SubmissionError,
  type DocumentInput,
} from "./submission-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
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
  // Receives every raw SQL statement issued, in call order — the advisory lock is the only one.
  onExecute?: (statement: unknown) => void;
};

function createDbMock(opts: DbMockOpts) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const inserts = [...(opts.inserts ?? [])];

  const db: Record<string, unknown> = {
    select: () => selectChain(selects.shift() ?? []),
    selectDistinct: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? [], opts.onSet),
    insert: () => insertChain(inserts.shift() ?? [], opts.onInsertValues),
    execute: (statement: unknown) => {
      opts.onExecute?.(statement);
      return Promise.resolve([]);
    },
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
    verificationStatus: "pending_verification",
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
      selects: [
        [ownerRow], // resolveOwnerInstitution
        [], // open-submission guard: nothing awaiting review
      ],
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
      selects: [[ownerRow], []],
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

  it("refuses a new submission once the institution is already verified", async () => {
    const verifiedOwnerRow = { ...ownerRow, verificationStatus: "verified" };
    const db = createDbMock({ selects: [[verifiedOwnerRow]] });

    const err = await catchAsync(() =>
      createVerificationSubmission("alice", companyDocs, "user_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("institution_already_verified");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("refuses a new submission while one is still awaiting review", async () => {
    const db = createDbMock({
      selects: [
        [ownerRow],
        [{ id: "sub_open" }], // open-submission guard finds a queued submission
      ],
    });

    const err = await catchAsync(() =>
      createVerificationSubmission("alice", companyDocs, "user_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("verification_submission_already_pending");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("takes the per-institution advisory lock before reading the open-submission guard", async () => {
    // Without the lock the guard is phantom-vulnerable: two concurrent submissions both read an
    // empty queue and both insert. Asserting the statement runs at all is what keeps a future edit
    // from quietly dropping it.
    const statements: unknown[] = [];
    const db = createDbMock({
      selects: [[ownerRow], []],
      inserts: [[submissionRow], [], []],
      onExecute: (statement) => statements.push(statement),
    });

    await createVerificationSubmission("alice", companyDocs, "user_1", db);

    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0])).toContain("pg_advisory_xact_lock");
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
    requestedPath: "documents",
  };

  const companyInst = {
    id: "inst_1",
    displayName: "PT Alice Corp",
    institutionType: "company",
    verificationStatus: "pending_verification",
    tickPath: null,
    nameProofDueAt: null,
    slug: "pt-alice-corp",
  };

  // The acted-on account row `resolvePlatformOpsActor` reads. It is the FIRST select inside the
  // transaction, so every fixture below leads with it.
  const opsActorRow = { id: "ops_1", role: "platform_ops", suspendedAt: null };

  // The conflict rule's four reads in order: a membership, a submission this actor filed, the acting
  // account's own address, and an invitation naming them. The queue is positional, so a fixture that
  // omits one slides every later answer up by one; `opsAccountRow` is required rather than optional,
  // because the rule cannot evaluate its address arm without it.
  const opsAccountRow = { email: "ops_1@lombakita.test" };

  it("reject — marks submission rejected with audit row, no institution status change", async () => {
    const db = createDbMock({
      selects: [
        [opsActorRow], // resolvePlatformOpsActor
        [companySub], // CAS fetch submission
        [companyInst], // fetch institution
        [], // conflict rule: no membership
        [], // conflict rule: this actor filed nothing here
        [opsAccountRow], // conflict rule: the acting account's own address
        [], // conflict rule: no invitation names them
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
      db,
    );

    expect(result.submissionId).toBe("sub_1");
    expect(result.status).toBe("rejected");
  });

  it("approve — sets verifiedAt, writes audit, marks approved", async () => {
    const db = createDbMock({
      selects: [
        [opsActorRow], // resolvePlatformOpsActor
        [companySub], // CAS fetch submission
        [companyInst], // fetch institution
        [], // conflict rule: no membership
        [], // conflict rule: this actor filed nothing here
        [opsAccountRow], // conflict rule: the acting account's own address
        [], // conflict rule: no invitation names them
        [], // the submitter is no longer an active owner, so nobody is trusted
      ],
      updates: [
        [{ id: "inst_1", verificationStatus: "verified" }], // institution update
        [{ id: "sub_1", status: "approved" }], // submission update
      ],
      inserts: [
        [{ id: "audit_1" }], // institutionVerificationAudit insert
      ],
    });

    const result = await reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db);

    expect(result.submissionId).toBe("sub_1");
    expect(result.status).toBe("approved");
  });

  it("refuses to approve a submission for an institution that is already verified", async () => {
    // verified→verified is not a legal transition, so a stale queue tab cannot re-approve an
    // institution and stamp a second verified_at over the original decision.
    const db = createDbMock({
      selects: [
        [opsActorRow],
        [companySub],
        [{ ...companyInst, verificationStatus: "verified" }],
        [],
        [],
        [opsAccountRow],
        [],
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );
    expect((err as { code: string }).code).toBe("verification_invalid_transition");
    expect((err as { status: number }).status).toBe(409);
  });

  it("returns 409 when the institution's status changed between reading and approving", async () => {
    // Zero rows updated: the CAS predicate no longer matches, because a revocation or another
    // approval landed first. The submission must not be marked approved on top of it.
    const db = createDbMock({
      selects: [[opsActorRow], [companySub], [companyInst], [], [], [opsAccountRow], []],
      updates: [[]],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("verification_transition_conflict");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("approval only transitions verification_status — it never writes institution_type", async () => {
    // The institution's type is fixed at creation; verification proves it, it does not change it.
    const setPayloads: Record<string, unknown>[] = [];
    const db = createDbMock({
      onSet: (payload) => setPayloads.push(payload),
      selects: [
        [opsActorRow],
        [companySub],
        [companyInst],
        [],
        [],
        [opsAccountRow],
        [],
        [], // the submitter is no longer an active owner, so nobody is trusted
      ],
      updates: [
        [{ id: "inst_1", verificationStatus: "verified" }],
        [{ id: "sub_1", status: "approved" }],
      ],
      inserts: [[{ id: "audit_1" }]],
    });

    const result = await reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db);

    expect(result.status).toBe("approved");
    expect(setPayloads.some((payload) => "institutionType" in payload)).toBe(false);
    // And it still verified.
    expect(setPayloads[0]).toMatchObject({ verificationStatus: "verified" });
  });

  it("CAS guard — double-review rejected (already approved)", async () => {
    const alreadyApproved = { ...companySub, status: "approved" };
    const db = createDbMock({
      selects: [
        [opsActorRow],
        [alreadyApproved], // CAS fetch — status is not pending_review
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("submission_already_reviewed");
    expect((err as SubmissionError).status).toBe(409);
  });

  it("returns 404 when submission not found", async () => {
    const db = createDbMock({ selects: [[opsActorRow], []] }); // empty result
    const err = await catchAsync(() =>
      reviewVerificationSubmission("no-sub", "approved", null, "ops_1", db),
    );
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("submission_not_found");
    expect((err as SubmissionError).status).toBe(404);
  });
});

// ─── Account-level refusals (the resolved actor is the authority) ─────────────

describe("reviewVerificationSubmission — resolvePlatformOpsActor refusals", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses for a missing account, a non-platform_ops role, and a suspended account", async () => {
    const actorRows = [
      [], // not found
      [{ id: "ops_1", role: "recruiter", suspendedAt: null }], // wrong role
      [{ id: "ops_1", role: "platform_ops", suspendedAt: new Date() }], // suspended
    ];

    for (const actorRow of actorRows) {
      const db = createDbMock({ selects: [actorRow] });
      const err = await catchAsync(() =>
        reviewVerificationSubmission("sub_1", "approved", null, "user_1", db),
      );
      expect(err).toBeInstanceOf(OperatorActorError);
      expect((err as OperatorActorError).status).toBe(403);
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

// ─── Path B (Instagram) and the tick path of an approval ──────────────────────

describe("createInstagramTickRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  const ownerRow = {
    institutionId: "inst_1",
    institutionType: "company",
    verificationStatus: "pending_verification",
    tickPath: null,
    membershipId: "mem_1",
  };
  const unticked = { verificationStatus: "pending_verification", nameProofDueAt: null };
  const LINK = "https://www.instagram.com/acme.org/";

  it("stores the link with requested_path instagram, no documents and no upload", async () => {
    const insertValues: Record<string, unknown>[] = [];
    const db = createDbMock({
      selects: [
        [ownerRow], // resolveOwnerInstitution
        [unticked], // the workspace read under the lock
        [], // closure: no staff closing row
        [], // closure: no removal row
        [], // no published paid competition
        [], // nothing awaiting review
      ],
      inserts: [[{ id: "sub_1" }]],
      onInsertValues: (payload) => insertValues.push(payload),
    });

    const result = await createInstagramTickRequest("alice", LINK, "user_1", db);

    expect(result).toEqual({ submissionId: "sub_1", documents: [] });
    expect(insertValues).toEqual([
      expect.objectContaining({
        institutionId: "inst_1",
        submittedByUserId: "user_1",
        targetInstitutionType: "company",
        emailDomainFlag: null,
        requestedPath: "instagram",
        instagramUrl: LINK,
      }),
    ]);
  });

  it("takes the per-institution advisory lock before it reads the workspace", async () => {
    const statements: unknown[] = [];
    const db = createDbMock({
      selects: [[ownerRow], [unticked], [], [], [], []],
      inserts: [[{ id: "sub_1" }]],
      onExecute: (statement) => statements.push(statement),
    });

    await createInstagramTickRequest("alice", LINK, "user_1", db);

    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0])).toContain("pg_advisory_xact_lock");
  });

  it("refuses a closed workspace with its cause, before anything is written", async () => {
    const inserts: Record<string, unknown>[] = [];
    const db = createDbMock({
      selects: [[ownerRow], [unticked], [{ id: "audit_9" }]],
      onInsertValues: (payload) => inserts.push(payload),
    });

    const err = await catchAsync(() => createInstagramTickRequest("alice", LINK, "user_1", db));

    expect(err).toBeInstanceOf(SubmissionError);
    expect(err).toMatchObject({
      code: "institution_tick_closed_needs_documents",
      status: 409,
      details: { cause: "staff", closedInstitutionId: "inst_1" },
    });
    expect(inserts).toEqual([]);
  });

  it("refuses a workspace that is not ticked while a paid competition is live", async () => {
    const db = createDbMock({
      selects: [[ownerRow], [unticked], [], [], [{ id: "comp_1" }]],
    });

    const err = await catchAsync(() => createInstagramTickRequest("alice", LINK, "user_1", db));

    expect(err).toMatchObject({ code: "institution_tick_live_paid_competition", status: 409 });
  });

  it("refuses a Path A tick while its name proof runs, and lets a Path A tick without one through", async () => {
    const domainOwner = { ...ownerRow, verificationStatus: "verified", tickPath: "domain" };
    const proofRunning = createDbMock({
      selects: [
        [domainOwner],
        [{ verificationStatus: "verified", nameProofDueAt: new Date("2026-12-01T00:00:00Z") }],
        [],
        [],
      ],
    });

    const err = await catchAsync(() =>
      createInstagramTickRequest("alice", LINK, "user_1", proofRunning),
    );

    expect(err).toMatchObject({ code: "institution_name_proof_needs_documents", status: 409 });

    const noProof = createDbMock({
      selects: [
        [domainOwner],
        [{ verificationStatus: "verified", nameProofDueAt: null }],
        [],
        [],
        [],
      ],
      inserts: [[{ id: "sub_2" }]],
    });

    await expect(createInstagramTickRequest("alice", LINK, "user_1", noProof)).resolves.toEqual({
      submissionId: "sub_2",
      documents: [],
    });
  });

  it("refuses a workspace that another path already ticked", async () => {
    const db = createDbMock({
      selects: [[{ ...ownerRow, verificationStatus: "verified", tickPath: "documents" }]],
    });

    const err = await catchAsync(() => createInstagramTickRequest("alice", LINK, "user_1", db));

    expect(err).toMatchObject({ code: "institution_already_verified", status: 409 });
  });

  it("refuses while another request awaits review", async () => {
    const db = createDbMock({
      selects: [[ownerRow], [unticked], [], [], [], [{ id: "sub_open" }]],
    });

    const err = await catchAsync(() => createInstagramTickRequest("alice", LINK, "user_1", db));

    expect(err).toMatchObject({ code: "verification_submission_already_pending", status: 409 });
  });
});

describe("reviewVerificationSubmission — the tick path of an approval", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseSub = {
    id: "sub_1",
    institutionId: "inst_1",
    targetInstitutionType: "company",
    proposedDisplayName: null,
    status: "pending_review",
    submittedByUserId: "user_1",
  };
  const baseInst = {
    id: "inst_1",
    displayName: "PT Alice Corp",
    institutionType: "company",
    verificationStatus: "pending_verification",
    tickPath: null,
    nameProofDueAt: null,
    slug: "pt-alice-corp",
  };
  const opsActorRow = { id: "ops_1", role: "platform_ops", suspendedAt: null };
  const opsAccountRow = { email: "ops_1@lombakita.test" };
  const conflictReads = [[], [], [opsAccountRow], []];
  const verifiedRow = { id: "inst_1", verificationStatus: "verified", tickPath: "instagram" };

  it("writes the requested path as the tick path of a Path B approval", async () => {
    const sets: Record<string, unknown>[] = [];
    const db = createDbMock({
      onSet: (payload) => sets.push(payload),
      selects: [
        [opsActorRow],
        [{ ...baseSub, requestedPath: "instagram" }],
        [baseInst],
        ...conflictReads,
        [], // closure: no staff closing row
        [], // closure: no removal row
        [], // no published paid competition
        [], // the submitter is no longer an owner
      ],
      updates: [[verifiedRow], [{ id: "sub_1" }]],
      inserts: [[{ id: "audit_1" }]],
    });

    const result = await reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db);

    expect(result.status).toBe("approved");
    expect(result.trustedSubmitter).toBe(false);
    expect(sets[0]).toMatchObject({ verificationStatus: "verified", tickPath: "instagram" });
  });

  it("writes the documents path for a Path C approval and trusts a submitter who is still an owner", async () => {
    const sets: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    const db = createDbMock({
      onSet: (payload) => sets.push(payload),
      onInsertValues: (payload) => inserts.push(payload),
      selects: [
        [opsActorRow],
        [{ ...baseSub, requestedPath: "documents" }],
        [baseInst],
        ...conflictReads,
        [{ id: "mem_1" }], // the submitter is still an active owner
        [{ id: "user_1" }], // the submitter meets the automatic trust condition
        [], // no other account's trust removal record, so no match and no key
      ],
      updates: [[{ ...verifiedRow, tickPath: "documents" }], [{ id: "sub_1" }], [{ id: "user_1" }]],
      inserts: [[{ id: "audit_1" }], []],
    });

    const result = await reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db);

    expect(result.trustedSubmitter).toBe(true);
    expect(sets[0]).toMatchObject({ tickPath: "documents", tickDomain: null });
    expect(inserts.at(-1)).toMatchObject({
      targetUserId: "user_1",
      eventType: "host_trust.raised_by_tick",
      metadata: { institutionId: "inst_1", submissionId: "sub_1", requestedPath: "documents" },
    });
  });

  it("refuses a Path B approval on a closed workspace and writes nothing", async () => {
    const sets: Record<string, unknown>[] = [];
    const db = createDbMock({
      onSet: (payload) => sets.push(payload),
      selects: [
        [opsActorRow],
        [{ ...baseSub, requestedPath: "instagram" }],
        [baseInst],
        ...conflictReads,
        [{ id: "audit_9" }],
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );

    expect(err).toMatchObject({
      code: "institution_tick_closed_needs_documents",
      status: 409,
      details: { cause: "staff", closedInstitutionId: "inst_1" },
    });
    expect(sets).toEqual([]);
  });

  it("refuses a Path B approval on a Path A tick while its name proof runs", async () => {
    const db = createDbMock({
      selects: [
        [opsActorRow],
        [{ ...baseSub, requestedPath: "instagram" }],
        [
          {
            ...baseInst,
            verificationStatus: "verified",
            tickPath: "domain",
            nameProofDueAt: new Date("2026-12-01T00:00:00Z"),
          },
        ],
        ...conflictReads,
        [],
        [],
      ],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );

    expect(err).toMatchObject({ code: "institution_name_proof_needs_documents", status: 409 });
  });

  it("names the cause when a Path B approval misses its write: a closure, a proof or a plain conflict", async () => {
    const instagramSub = { ...baseSub, requestedPath: "instagram" };
    const guardReads = [[], [], []];
    const missedWrite = (rereads: unknown[][]) =>
      createDbMock({
        selects: [
          [opsActorRow],
          [instagramSub],
          [baseInst],
          ...conflictReads,
          ...guardReads,
          ...rereads,
        ],
        updates: [[]],
      });

    const closed = await catchAsync(() =>
      reviewVerificationSubmission(
        "sub_1",
        "approved",
        null,
        "ops_1",
        missedWrite([[{ id: "a" }]]),
      ),
    );
    const proof = await catchAsync(() =>
      reviewVerificationSubmission(
        "sub_1",
        "approved",
        null,
        "ops_1",
        missedWrite([[], [], [{ nameProofDueAt: new Date("2026-12-01T00:00:00Z") }]]),
      ),
    );
    const plain = await catchAsync(() =>
      reviewVerificationSubmission(
        "sub_1",
        "approved",
        null,
        "ops_1",
        missedWrite([[], [], [{ nameProofDueAt: null }]]),
      ),
    );

    expect(closed).toMatchObject({ code: "institution_tick_closed_needs_documents" });
    expect(proof).toMatchObject({ code: "institution_name_proof_needs_documents" });
    expect(plain).toMatchObject({ code: "verification_transition_conflict" });
  });

  it("answers a Path C approval that misses its write with the plain conflict", async () => {
    const db = createDbMock({
      selects: [
        [opsActorRow],
        [{ ...baseSub, requestedPath: "documents" }],
        [baseInst],
        ...conflictReads,
      ],
      updates: [[]],
    });

    const err = await catchAsync(() =>
      reviewVerificationSubmission("sub_1", "approved", null, "ops_1", db),
    );

    expect(err).toBeInstanceOf(SubmissionError);
    expect(err).toMatchObject({ code: "verification_transition_conflict", status: 409 });
  });
});
