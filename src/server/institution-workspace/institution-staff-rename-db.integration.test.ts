// @vitest-environment node

// The staff rename and slug change against real rows. Accounts come through the real sign-up, code
// verification and host step services, the Email organisasi through its real code services,
// workspaces and competitions through their services, ticks through the tick and approval services,
// and the rename through the real route handler. A row is planted directly only where a test says so.
//
// The last describe COMMITS, because one connection cannot wait on itself: a second connection holds
// a row lock the rename is expected to wait on. Every committed row is deleted by id in a finally,
// and what survived is asserted.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, asc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  organizationCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
}));

// The routes read the pooled connection and the session cookie, and this process has neither. Both
// are staged per request and reset before each test.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, authSecret: "test-registration-code-secret" },
  };
});

vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: async (options: { email: string; code: string }) => {
    mocks.sentCodes.push({ email: options.email, code: options.code });
  },
  sendOrganizationEmailCode: async (options: { email: string; code: string }) => {
    mocks.organizationCodes.push({ email: options.email, code: options.code });
  },
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    checkFixedWindowLimitFailClosed: async (params: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => {
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueCompetitionSearchSync: vi.fn(async () => ({})),
    enqueueCompetitionEdited: vi.fn(async () => ({})),
    enqueueRegistrationConfirmed: vi.fn(async () => ({})),
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: vi.fn(async () => ({})),
    enqueueHostTrustRemoved: vi.fn(async () => ({})),
    enqueueInstitutionTickNotice: vi.fn(async () => ({})),
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => routeState.transaction ?? actual.getDb() };
});

vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return {
    ...actual,
    isR2Available: () => true,
    generatePresignedPutUrl: async (key: string) => `https://r2.test/${key}`,
    listObjects: async () => [],
    deleteObject: async () => undefined,
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) throw new Error("a route ran with no session staged");
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
  requireSessionRole: async () => {
    if (!routeState.actorUserId) throw new Error("a route ran with no session staged");
    return {
      user: { id: routeState.actorUserId, role: "platform_ops" },
    } as unknown as AuthenticatedSession;
  },
}));

import { RESERVED_WORDS } from "@/lib/username/reserved-words";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createInstitutionWorkspaceForUser,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import { renameInstitutionAsStaff } from "@/server/institution-workspace/institution-staff-rename-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import {
  createCompetitionDraft,
  transitionCompetitionStatus,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { enqueueCompetitionSearchSync, enqueueInstitutionTickNotice } from "@/server/async/enqueue";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { decideNameCheck } from "@/server/institution-verification/name-check-service";
import { reviewVerificationSubmission } from "@/server/institution-verification/submission-service";
import { tickByOrganizationDomain } from "@/server/institution-verification/tick-service";
import { PATCH as identityRoute } from "@/app/api/platform-ops/institutions/[institutionId]/identity/route";
import { POST as submitRoute } from "@/app/api/v1/institutions/[institutionSlug]/verification/submit/route";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const PASSWORD = "fresh-pass-3";

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_REASON = "Kirim akta pendirian dan surat keputusan pengurus.";
const RENAME_REASON = "Nama disesuaikan dengan akta pendirian.";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (test: (tx: Database) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("No test database");
  try {
    await db.transaction(async (tx) => {
      await test(tx as unknown as Database);
      (tx as Tx).rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

const searchSpy = () => vi.mocked(enqueueCompetitionSearchSync);
const noticeSpy = () => vi.mocked(enqueueInstitutionTickNotice);

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
  searchSpy().mockClear();
  noticeSpy().mockClear();
});

// ── Accounts, workspaces and staff ───────────────────────────────────────────────────────────

// A fresh part for every address and name, so test files running at once never wait on one
// another's uncommitted unique rows.
const freshPart = (): string => randomUUID().slice(0, 8);

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const latestOrganizationCodeFor = (address: string): string => {
  const sent = mocks.organizationCodes.filter((entry) => entry.email === address).at(-1);
  if (!sent) throw new Error(`No Email organisasi code was sent to ${address}`);
  return sent.code;
};

const userIdOfAddress = async (tx: Database, address: string): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, address));
  if (!row) throw new Error("No user row");
  return row.id;
};

const signUpParticipant = async (tx: Database, address: string): Promise<string> => {
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, email: address, password: PASSWORD },
    tx,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, email: address, code: latestCode(), password: PASSWORD },
    tx,
  );
  return userIdOfAddress(tx, address);
};

// Signs in under .local, which no trust source accepts, so the account is a host and untrusted until
// something else trusts it.
const signUpHost = async (tx: Database, label: string): Promise<string> => {
  const userId = await signUpParticipant(tx, `${label}.${freshPart()}@pemilik.local`);
  await markRoleAsVerified(userId, "recruiter", null, tx);
  return userId;
};

const usernameOf = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.username;
};

// Confirms an Email organisasi through the real code services, which also trusts the account.
const confirmOrganizationEmail = async (
  tx: Database,
  userId: string,
  address: string,
): Promise<void> => {
  await issueOrganizationEmailCode(userId, address, tx);
  await confirmOrganizationEmailCode(userId, latestOrganizationCodeFor(address), tx);
};

const seedStaff = async (tx: Database): Promise<string> => {
  const suffix = freshPart();
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `ops_rename_${suffix}@example.test`,
      username: `ops_rename_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No staff row");
  return row.id;
};

type Owner = { institutionId: string; slug: string; ownerId: string };

const createWorkspace = async (tx: Database, ownerId: string): Promise<Owner> => {
  const workspace = await createInstitutionWorkspaceForUser(
    ownerId,
    { displayName: `Ruang Kerja ${freshPart()}`, institutionType: "company" },
    tx,
  );
  return { institutionId: workspace.institutionId, slug: workspace.slug, ownerId };
};

// The owner signed up and took the host step, confirmed an Email organisasi (which trusts the
// account), created the workspace and saved its website.
const buildTickOwner = async (tx: Database): Promise<Owner> => {
  const ownerId = await signUpHost(tx, "pemilik");
  await confirmOrganizationEmail(tx, ownerId, `budi.${freshPart()}@students.acme.example`);
  const owner = await createWorkspace(tx, ownerId);
  await updateInstitutionProfileForOwnerBySlug(
    ownerId,
    owner.slug,
    { websiteUrl: "https://www.acme.example" },
    tx,
  );
  return owner;
};

// A Path A tick: the workspace ticked through tickByOrganizationDomain.
const buildPathATick = async (tx: Database): Promise<Owner> => {
  const owner = await buildTickOwner(tx);
  await tickByOrganizationDomain(owner.ownerId, owner.slug, tx);
  return owner;
};

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────

const validTimeline = () => {
  const now = Date.now();
  return {
    registrationStartAt: new Date(now + 7 * DAY_MS),
    registrationEndAt: new Date(now + 14 * DAY_MS),
    participantConfirmationAt: new Date(now + 20 * DAY_MS),
    eventStartAt: new Date(now + 30 * DAY_MS),
    eventEndAt: new Date(now + 31 * DAY_MS),
    resultAnnouncementAt: new Date(now + 40 * DAY_MS),
  };
};

const createPublishableDraft = async (
  tx: Database,
  owner: Owner,
  title: string,
): Promise<string> => {
  const draft = await createCompetitionDraft(
    owner.ownerId,
    {
      institutionSlug: owner.slug,
      title,
      description: "Deskripsi kompetisi untuk pengujian.",
      slug: null,
      category: "hackathon",
      mode: "individual",
      ...validTimeline(),
    },
    tx,
  );
  await updateCompetitionDraft(owner.ownerId, draft.id, { location: "online" }, tx);
  await setCompetitionEligibilityForEditor(owner.ownerId, draft.id, { audience: ["umum"] }, tx);
  await setCompetitionOrganizerContactForEditor(
    owner.ownerId,
    draft.id,
    { kind: "whatsapp", value: "081298765432" },
    tx,
  );
  return draft.id;
};

const createPublishedCompetition = async (tx: Database, owner: Owner): Promise<string> => {
  const competitionId = await createPublishableDraft(tx, owner, `Kompetisi ${freshPart()}`);
  await transitionCompetitionStatus(owner.ownerId, competitionId, "published", tx);
  return competitionId;
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

const COMPANY_DOCUMENTS = ["npwp", "nib"].map((documentType) => ({
  documentType,
  originalFileName: `${documentType}.pdf`,
  fileSizeBytes: 1024,
  contentType: "application/pdf",
}));

const submitDocuments = async (tx: Database, owner: Owner): Promise<string> => {
  routeState.transaction = tx;
  routeState.actorUserId = owner.ownerId;
  const response = await submitRoute(
    new Request(`http://localhost/api/v1/institutions/${owner.slug}/verification/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: owner.ownerId },
      body: JSON.stringify({ documents: COMPANY_DOCUMENTS }),
    }),
    { params: Promise.resolve({ institutionSlug: owner.slug }) },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { submissionId?: string };
  return body.submissionId!;
};

const approve = (tx: Database, staffId: string, submissionId: string) =>
  reviewVerificationSubmission(submissionId, "approved", null, staffId, tx);

// A Path C approval: the way a workspace is ticked by documents.
const tickByDocuments = async (tx: Database, owner: Owner, staffId: string): Promise<void> => {
  await approve(tx, staffId, await submitDocuments(tx, owner));
};

type IdentityAnswer = {
  status: number;
  body: { error?: { code: string }; institution?: Record<string, unknown> };
};

const patchIdentity = async (
  database: Database,
  staffId: string,
  institutionId: string,
  body: Record<string, unknown>,
): Promise<IdentityAnswer> => {
  routeState.transaction = database;
  routeState.actorUserId = staffId;
  const response = await identityRoute(
    new Request(`http://localhost/api/platform-ops/institutions/${institutionId}/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionId }) },
  );
  return { status: response.status, body: await response.json() };
};

const refusalOf = async (promise: Promise<unknown>): Promise<unknown> => {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) throw new Error("Expected a refusal, but the call resolved");
  return outcome;
};

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

const readWorkspace = async (tx: Database, institutionId: string) => {
  const [row] = await tx
    .select({
      verificationStatus: schema.institutions.verificationStatus,
      tickPath: schema.institutions.tickPath,
      tickDomain: schema.institutions.tickDomain,
      nameCheckedAt: schema.institutions.nameCheckedAt,
      nameProofDueAt: schema.institutions.nameProofDueAt,
      nameProofRemindedAt: schema.institutions.nameProofRemindedAt,
      displayName: schema.institutions.displayName,
      slug: schema.institutions.slug,
    })
    .from(schema.institutions)
    .where(eq(schema.institutions.id, institutionId));
  if (!row) throw new Error("No institution row");
  return row;
};

const auditRowsOf = (tx: Database, institutionId: string) =>
  tx
    .select({
      fromStatus: schema.institutionVerificationAudit.fromStatus,
      toStatus: schema.institutionVerificationAudit.toStatus,
      reason: schema.institutionVerificationAudit.reason,
      actorUserId: schema.institutionVerificationAudit.actorUserId,
    })
    .from(schema.institutionVerificationAudit)
    .where(eq(schema.institutionVerificationAudit.institutionId, institutionId))
    .orderBy(
      asc(schema.institutionVerificationAudit.createdAt),
      asc(schema.institutionVerificationAudit.id),
    );

const platformAuditRowsOf = (tx: Database, institutionId: string) =>
  tx
    .select({
      actorUserId: schema.platformOpsAuditLogs.actorUserId,
      targetInstitutionId: schema.platformOpsAuditLogs.targetInstitutionId,
      eventType: schema.platformOpsAuditLogs.eventType,
      reason: schema.platformOpsAuditLogs.reason,
      metadata: schema.platformOpsAuditLogs.metadata,
    })
    .from(schema.platformOpsAuditLogs)
    .where(eq(schema.platformOpsAuditLogs.targetInstitutionId, institutionId));

// "No row change": the name, the address, the status, the five tick columns and the audit rows of
// both logs.
const snapshotOf = async (tx: Database, institutionId: string) => ({
  workspace: await readWorkspace(tx, institutionId),
  verificationAuditRows: (await auditRowsOf(tx, institutionId)).length,
  platformAuditRows: (await platformAuditRowsOf(tx, institutionId)).length,
});

const searchCalls = () => searchSpy().mock.calls.map(([call]) => call);
const noticePayloads = () => noticeSpy().mock.calls.map(([call]) => call.payload);

const freshName = (): string => `Nama Baru ${freshPart()}`;
const freshSlug = (): string => `nama-baru-${freshPart()}`;

describe.skipIf(skipWithoutDatabase)("the staff rename (real database)", () => {
  it("staff rename a workspace with a reason", async () => {
    await inRollback(async (tx) => {
      const staffId = await seedStaff(tx);
      const owner = await buildTickOwner(tx);
      await tickByDocuments(tx, owner, staffId);
      const publishedId = await createPublishedCompetition(tx, owner);
      const draftId = await createPublishableDraft(tx, owner, `Draf ${freshPart()}`);
      const before = await readWorkspace(tx, owner.institutionId);
      const verificationAuditBefore = await auditRowsOf(tx, owner.institutionId);
      const platformAuditBefore = await platformAuditRowsOf(tx, owner.institutionId);
      searchSpy().mockClear();
      noticeSpy().mockClear();

      const displayName = freshName();
      const slug = freshSlug();
      const answer = await patchIdentity(tx, staffId, owner.institutionId, {
        displayName,
        slug,
        reason: RENAME_REASON,
      });

      expect(answer.status).toBe(200);
      expect(answer.body.institution).toEqual({
        institutionId: owner.institutionId,
        displayName,
        slug,
      });
      const after = await readWorkspace(tx, owner.institutionId);
      expect(after.displayName).toBe(displayName);
      expect(after.slug).toBe(slug);
      expect(after.verificationStatus).toBe("verified");
      expect(after.tickPath).toBe("documents");
      expect(await auditRowsOf(tx, owner.institutionId)).toHaveLength(
        verificationAuditBefore.length,
      );
      const platformAudit = await platformAuditRowsOf(tx, owner.institutionId);
      expect(platformAudit.slice(platformAuditBefore.length)).toEqual([
        {
          actorUserId: staffId,
          targetInstitutionId: owner.institutionId,
          eventType: "institution.renamed_by_staff",
          reason: RENAME_REASON,
          metadata: {
            from: { displayName: before.displayName, slug: before.slug },
            to: { displayName, slug },
          },
        },
      ]);
      expect(searchCalls()).toHaveLength(2);
      expect(searchCalls()).toEqual(
        expect.arrayContaining([
          { competitionId: publishedId, action: "upsert" },
          { competitionId: draftId, action: "upsert" },
        ]),
      );
      expect(noticePayloads()).toEqual([
        {
          institutionId: owner.institutionId,
          kind: "renamed_by_staff",
          reason: RENAME_REASON,
          epoch: expect.any(Number),
        },
      ]);

      searchSpy().mockClear();
      noticeSpy().mockClear();
      const platformAuditAfterFirst = await platformAuditRowsOf(tx, owner.institutionId);
      const repeated = await patchIdentity(tx, staffId, owner.institutionId, {
        displayName,
        slug,
        reason: RENAME_REASON,
      });

      expect(repeated.status).toBe(200);
      expect(repeated.body.institution).toEqual({
        institutionId: owner.institutionId,
        displayName,
        slug,
      });
      expect(await platformAuditRowsOf(tx, owner.institutionId)).toHaveLength(
        platformAuditAfterFirst.length,
      );
      expect(searchSpy()).not.toHaveBeenCalled();
      expect(noticeSpy()).not.toHaveBeenCalled();
    });
  });

  it("a staff rename of a Path A workspace ends its name proof and marks the name checked", async () => {
    await inRollback(async (tx) => {
      const firstStaff = await seedStaff(tx);
      const secondStaff = await seedStaff(tx);
      const owner = await buildPathATick(tx);
      await decideNameCheck(
        firstStaff,
        owner.institutionId,
        { decision: "require_proof", reason: PROOF_REASON },
        tx,
      );
      const proofRunning = await readWorkspace(tx, owner.institutionId);
      expect(proofRunning.nameProofDueAt).not.toBeNull();
      const auditBefore = await auditRowsOf(tx, owner.institutionId);

      const answer = await patchIdentity(tx, secondStaff, owner.institutionId, {
        displayName: freshName(),
        reason: RENAME_REASON,
      });

      expect(answer.status).toBe(200);
      const after = await readWorkspace(tx, owner.institutionId);
      expect(after.verificationStatus).toBe("verified");
      expect(after.tickPath).toBe("domain");
      expect(after.nameCheckedAt).not.toBeNull();
      expect(after.nameProofDueAt).toBeNull();
      expect(after.nameProofRemindedAt).toBeNull();
      const auditAfter = await auditRowsOf(tx, owner.institutionId);
      expect(auditAfter.slice(auditBefore.length)).toEqual([
        {
          fromStatus: "verified",
          toStatus: "verified",
          reason: RENAME_REASON,
          actorUserId: secondStaff,
        },
      ]);
    });
  });

  it("the staff rename guards", async () => {
    await inRollback(async (tx) => {
      const staffId = await seedStaff(tx);
      const owner = await buildPathATick(tx);
      const candidateId = await signUpParticipant(tx, `calon.${freshPart()}@example.test`);
      const knownUsername = await usernameOf(tx, candidateId);
      const conflictedStaff = await seedStaff(tx);
      // Planted directly: the conflict rule's own tests prove it for every relationship, so one
      // membership stands for them here.
      await tx.insert(schema.institutionMemberships).values({
        institutionId: owner.institutionId,
        userId: conflictedStaff,
        membershipRole: "institution_owner",
        status: "active",
      });
      const otherOwner = await createWorkspace(tx, await signUpHost(tx, "lain"));
      const before = await snapshotOf(tx, owner.institutionId);
      searchSpy().mockClear();
      noticeSpy().mockClear();

      const expectRefused = async (
        attempt: Promise<unknown>,
        expected: Record<string, unknown>,
      ): Promise<void> => {
        expect(await refusalOf(attempt)).toMatchObject(expected);
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
        expect(searchSpy()).not.toHaveBeenCalled();
        expect(noticeSpy()).not.toHaveBeenCalled();
      };
      const renameAs = (actorId: string, input: { slug?: string; reason?: string }) =>
        renameInstitutionAsStaff(
          actorId,
          owner.institutionId,
          {
            ...(input.slug === undefined ? { displayName: freshName() } : { slug: input.slug }),
            reason: input.reason ?? RENAME_REASON,
          },
          tx,
        );

      await expectRefused(renameAs(candidateId, {}), {
        code: "operator_actor_not_platform_ops",
        status: 403,
      });
      await expectRefused(renameAs(conflictedStaff, {}), {
        code: "operator_actor_conflicted",
        status: 403,
      });
      for (const reason of ["", "   ", "x".repeat(1001)]) {
        await expectRefused(renameAs(staffId, { reason }), {
          code: "institution_rename_reason_required",
          httpStatus: 400,
        });
      }
      expect(RESERVED_WORDS).toContain("admin");
      await expectRefused(renameAs(staffId, { slug: "admin" }), {
        code: "institution_slug_reserved",
        httpStatus: 422,
      });
      await expectRefused(renameAs(staffId, { slug: "deleted-abc" }), {
        code: "institution_slug_reserved",
        httpStatus: 422,
      });
      await expectRefused(renameAs(staffId, { slug: knownUsername.replace(/_/g, "-") }), {
        code: "institution_slug_conflicts_with_username",
        httpStatus: 409,
      });
      await expectRefused(renameAs(staffId, { slug: otherOwner.slug }), {
        code: "institution_invalid_value",
        httpStatus: 400,
      });
      expect(await refusalOf(renameAs(staffId, { reason: "" }))).toBeInstanceOf(
        InstitutionWorkspaceInputError,
      );
      expect(await refusalOf(renameAs(candidateId, {}))).toBeInstanceOf(OperatorActorError);
    });
  });
});

// ── Committed rows: a lock the rename must wait on ───────────────────────────────────────────

type Connection = {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (): Connection => {
  const connection = postgres(TEST_DATABASE_URL!, { max: 1, idle_timeout: 0 });
  return { sql: connection, db: drizzle(connection, { schema }) };
};

const asDatabase = (connection: Connection): Database => connection.db as unknown as Database;

const backendPidOf = async (connection: Connection): Promise<number> => {
  const rows = await connection.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return Number(rows[0]!.pid);
};

const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 5;

// Waits until `waiterPid` is queued behind `holderPid`, reading Postgres's own wait graph.
const awaitBlockedBy = async (
  control: Connection,
  waiterPid: number,
  holderPid: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  let lastSeen: number[] = [];
  while (Date.now() < deadline) {
    const rows = await control.sql<{ pid: number }[]>`
      with recursive chain(pid) as (
        select unnest(pg_blocking_pids(${waiterPid}))
        union
        select unnest(pg_blocking_pids(chain.pid)) from chain
      )
      select pid from chain`;
    lastSeen = rows.map((row) => Number(row.pid));
    if (lastSeen.includes(holderPid)) return;
    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
  }
  throw new Error(
    `${what} never queued behind the lock this test holds (blockers [${lastSeen.join(", ")}] never ` +
      `included ${holderPid}). THIS IS THE GUARD-REMOVAL SIGNAL, NOT A FLAKE: do not raise the timeout.`,
  );
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(work: Promise<T>): Promise<Settled<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

// Runs `holdWork` in a transaction on `holder` and keeps it open while `during` runs, then commits.
// The racer `during` starts is awaited after the commit, so it can only proceed once the lock is gone.
const holdTransactionWhile = async <T>(
  holder: Connection,
  holdWork: (tx: Database) => Promise<unknown>,
  during: () => Promise<{ racer: Promise<Settled<T>> }>,
): Promise<Settled<T>> => {
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => (markHeld = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));

  const holding = holder.db.transaction(async (tx) => {
    await holdWork(tx as unknown as Database);
    markHeld();
    await released;
  });

  await Promise.race([
    held,
    holding.then(() => {
      throw new Error("the holding transaction ended before it took its lock");
    }),
  ]);

  let started: { racer: Promise<Settled<T>> } | null = null;
  try {
    started = await during();
  } finally {
    release();
    await holding.catch(() => undefined);
  }
  if (started === null) throw new Error("the racer never started");
  return started.racer;
};

describe.skipIf(skipWithoutDatabase)(
  "the staff rename waits for a committed row lock (committed rows)",
  () => {
    const createdUserIds: string[] = [];
    const createdInstitutionIds: string[] = [];
    let control: Connection;
    let holder: Connection;
    let racer: Connection;

    // Connections open once for the describe and close whether or not a test passed.
    beforeAll(() => {
      control = openConnection();
      holder = openConnection();
      racer = openConnection();
    });
    afterAll(async () => {
      await Promise.all([control?.sql.end(), holder?.sql.end(), racer?.sql.end()]);
    });

    // Audit rows of the platform_ops log restrict the deletes of their users and institutions, so
    // they go first.
    const sweep = async (): Promise<void> => {
      if (createdInstitutionIds.length > 0 || createdUserIds.length > 0) {
        await control.db
          .delete(schema.platformOpsAuditLogs)
          .where(
            or(
              inArray(schema.platformOpsAuditLogs.targetInstitutionId, createdInstitutionIds),
              inArray(schema.platformOpsAuditLogs.actorUserId, createdUserIds),
              inArray(schema.platformOpsAuditLogs.targetUserId, createdUserIds),
            ),
          );
      }
      if (createdInstitutionIds.length > 0) {
        await control.db
          .delete(schema.institutions)
          .where(inArray(schema.institutions.id, createdInstitutionIds));
      }
      if (createdUserIds.length > 0) {
        await control.db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
      }
    };

    const survivors = async (): Promise<{
      users: number;
      institutions: number;
      auditLogs: number;
    }> => {
      const users =
        createdUserIds.length === 0
          ? []
          : await control.db
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(inArray(schema.users.id, createdUserIds));
      const institutionRows =
        createdInstitutionIds.length === 0
          ? []
          : await control.db
              .select({ id: schema.institutions.id })
              .from(schema.institutions)
              .where(inArray(schema.institutions.id, createdInstitutionIds));
      const auditLogs =
        createdInstitutionIds.length === 0
          ? []
          : await control.db
              .select({ id: schema.platformOpsAuditLogs.id })
              .from(schema.platformOpsAuditLogs)
              .where(
                inArray(schema.platformOpsAuditLogs.targetInstitutionId, createdInstitutionIds),
              );
      return {
        users: users.length,
        institutions: institutionRows.length,
        auditLogs: auditLogs.length,
      };
    };

    // Everything below runs on the control connection and commits, so it is built from real
    // services and recorded for the sweep as it is made.
    const seedCommittedPathATick = async (): Promise<Owner> => {
      const owner = await buildPathATick(asDatabase(control));
      createdUserIds.push(owner.ownerId);
      createdInstitutionIds.push(owner.institutionId);
      return owner;
    };

    const seedCommittedStaff = async (): Promise<string> => {
      const staffId = await seedStaff(asDatabase(control));
      createdUserIds.push(staffId);
      return staffId;
    };

    it("a staff rename of a workspace whose tick an approval just moved off domain", async () => {
      try {
        const owner = await seedCommittedPathATick();
        const staffId = await seedCommittedStaff();
        const database = asDatabase(control);
        const requestId = await submitDocuments(database, owner);
        const before = await readWorkspace(database, owner.institutionId);
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);
        searchSpy().mockClear();
        noticeSpy().mockClear();

        const outcome = await holdTransactionWhile(
          holder,
          (tx) => approve(tx, staffId, requestId),
          async () => {
            const running = settle(
              patchIdentity(asDatabase(racer), staffId, owner.institutionId, {
                displayName: freshName(),
                slug: freshSlug(),
                reason: RENAME_REASON,
              }),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the staff rename");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(true);
        const answer = outcome.ok ? outcome.value : null;
        expect(answer?.status).toBe(409);
        expect(answer?.body.error?.code).toBe("verification_transition_conflict");
        const row = await readWorkspace(database, owner.institutionId);
        expect(row.displayName).toBe(before.displayName);
        expect(row.slug).toBe(before.slug);
        expect(row.tickPath).toBe("documents");
        const events = (await platformAuditRowsOf(database, owner.institutionId)).map(
          (auditRow) => auditRow.eventType,
        );
        expect(events).not.toContain("institution.renamed_by_staff");
        expect(searchSpy()).not.toHaveBeenCalled();
        expect(noticePayloads().filter((payload) => payload.kind === "renamed_by_staff")).toEqual(
          [],
        );
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);
  },
);
