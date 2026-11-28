// @vitest-environment node

// The Instagram and documents requests, their approval and the trust of the submitter, the staff
// override and the closed set of the submit body, against real rows in a transaction that is always
// rolled back. Accounts come through the real sign-up, code verification and host step services, the
// Email organisasi through its real code services, workspaces and invitations through their
// services, requests through the real submit route handler with the Rule 16 header, and decisions
// through the real decision services. A row is planted directly only where no service writes that
// state, and each place says why.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, asc, eq, inArray, or } from "drizzle-orm";
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

const hostKeys = vi.hoisted(() => ({ one: Buffer.alloc(32, 11).toString("base64") }));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: "test-registration-code-secret",
      hostIdentityHashKey: hostKeys.one,
    },
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
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

import { serverEnv } from "@/config/env.server";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createInstitutionWorkspaceForUser,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  acceptInstitutionInvitationForUser,
  createInstitutionInvitation,
} from "@/server/institution-invitations/invitation-service";
import { removeMember } from "@/server/institution-members/member-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import { removeHostTrust } from "@/server/host-trust/host-trust-removal-service";
import {
  findRemovedHostMatch,
  HostIdentityKeyError,
} from "@/server/host-trust/removed-host-identity";
import { enqueueInstitutionTickNotice } from "@/server/async/enqueue";
import { decideNameCheck, listTickQueue } from "./name-check-service";
import { reviewVerificationSubmission, SubmissionError } from "./submission-service";
import { tickByOrganizationDomain } from "./tick-service";
import { verifyInstitution } from "./verification-service";
import { VerificationError } from "./verification-core";
import { POST as submitRoute } from "@/app/api/v1/institutions/[institutionSlug]/verification/submit/route";
import { PATCH as settingsRoute } from "@/app/api/v1/institutions/[institutionSlug]/settings/route";
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

const useHostIdentityKey = (value: string | undefined) => {
  (serverEnv as { hostIdentityHashKey?: string }).hostIdentityHashKey = value;
};

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
  vi.mocked(enqueueInstitutionTickNotice).mockClear();
  useHostIdentityKey(hostKeys.one);
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

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
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
      email: `ops_tick_${suffix}@example.test`,
      username: `ops_tick_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No staff row");
  return row.id;
};

type Workspace = { institutionId: string; slug: string };

const createWorkspace = async (
  tx: Database,
  ownerId: string,
  institutionType: "company" | "personal" = "company",
): Promise<Workspace> => {
  const workspace = await createInstitutionWorkspaceForUser(
    ownerId,
    { displayName: `Ruang Kerja ${freshPart()}`, institutionType },
    tx,
  );
  return { institutionId: workspace.institutionId, slug: workspace.slug };
};

type Owner = Workspace & { ownerId: string };

// An owner on a Gmail-style sign-in: a host who took the host step and is not trusted.
const buildUntrustedOwner = async (
  tx: Database,
  institutionType: "company" | "personal" = "company",
): Promise<Owner> => {
  const ownerId = await signUpHost(tx, "pemilik");
  return { ...(await createWorkspace(tx, ownerId, institutionType)), ownerId };
};

// The Path A owner: Email organisasi confirmed (which trusts the account), workspace created and its
// website saved.
const buildTickOwner = async (tx: Database): Promise<Owner> => {
  const ownerId = await signUpHost(tx, "pemilik");
  await confirmOrganizationEmail(tx, ownerId, `budi.${freshPart()}@students.acme.example`);
  const workspace = await createWorkspace(tx, ownerId);
  await updateInstitutionProfileForOwnerBySlug(
    ownerId,
    workspace.slug,
    { websiteUrl: "https://www.acme.example" },
    tx,
  );
  return { ...workspace, ownerId };
};

const addCoOwner = async (tx: Database, owner: Owner): Promise<string> => {
  const userId = await signUpHost(tx, "rekan");
  const invitation = await createInstitutionInvitation(
    owner.ownerId,
    owner.slug,
    { invitedIdentifier: await usernameOf(tx, userId), invitedRole: "institution_owner" },
    tx,
  );
  await acceptInstitutionInvitationForUser(invitation.id, userId, ["candidate", "recruiter"], tx);
  return userId;
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
) => Promise<Response>;

type RouteAnswer = {
  status: number;
  body: { error?: { code: string }; submissionId?: string; documents?: unknown[] };
};

const callRoute = async (
  tx: Database,
  handler: RouteHandler,
  actorUserId: string,
  slug: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<RouteAnswer> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const response = await handler(
    new Request(`http://localhost/api/v1/institutions/${slug}`, {
      method,
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: actorUserId },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionSlug: slug }) },
  );
  return { status: response.status, body: await response.json() };
};

const submit = (tx: Database, owner: Owner, body: Record<string, unknown>) =>
  callRoute(tx, submitRoute, owner.ownerId, owner.slug, "POST", body);

const COMPANY_DOCUMENTS = ["npwp", "nib"].map((documentType) => ({
  documentType,
  originalFileName: `${documentType}.pdf`,
  fileSizeBytes: 1024,
  contentType: "application/pdf",
}));

const INSTAGRAM_REQUEST = { path: "instagram", instagramUrl: "https://instagram.com/acme.org" };

const submitDocuments = async (tx: Database, owner: Owner): Promise<string> => {
  const answer = await submit(tx, owner, { documents: COMPANY_DOCUMENTS });
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const submitInstagram = async (tx: Database, owner: Owner, url?: string): Promise<string> => {
  const answer = await submit(tx, owner, {
    path: "instagram",
    instagramUrl: url ?? INSTAGRAM_REQUEST.instagramUrl,
  });
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const approve = (tx: Database, staffId: string, submissionId: string) =>
  reviewVerificationSubmission(submissionId, "approved", null, staffId, tx);

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
    })
    .from(schema.institutionVerificationAudit)
    .where(eq(schema.institutionVerificationAudit.institutionId, institutionId))
    .orderBy(
      asc(schema.institutionVerificationAudit.createdAt),
      asc(schema.institutionVerificationAudit.id),
    );

const submissionRowsOf = (tx: Database, institutionId: string) =>
  tx
    .select({
      id: schema.institutionVerificationSubmissions.id,
      status: schema.institutionVerificationSubmissions.status,
      requestedPath: schema.institutionVerificationSubmissions.requestedPath,
      instagramUrl: schema.institutionVerificationSubmissions.instagramUrl,
      targetInstitutionType: schema.institutionVerificationSubmissions.targetInstitutionType,
      emailDomainFlag: schema.institutionVerificationSubmissions.emailDomainFlag,
      reviewerUserId: schema.institutionVerificationSubmissions.reviewerUserId,
      reviewerNotes: schema.institutionVerificationSubmissions.reviewerNotes,
    })
    .from(schema.institutionVerificationSubmissions)
    .where(eq(schema.institutionVerificationSubmissions.institutionId, institutionId))
    .orderBy(asc(schema.institutionVerificationSubmissions.submittedAt));

const raisedByTickRowsOf = (tx: Database, targetUserId: string) =>
  tx
    .select({
      actorUserId: schema.platformOpsAuditLogs.actorUserId,
      targetUserId: schema.platformOpsAuditLogs.targetUserId,
      eventType: schema.platformOpsAuditLogs.eventType,
      metadata: schema.platformOpsAuditLogs.metadata,
    })
    .from(schema.platformOpsAuditLogs)
    .where(
      and(
        eq(schema.platformOpsAuditLogs.targetUserId, targetUserId),
        eq(schema.platformOpsAuditLogs.eventType, "host_trust.raised_by_tick"),
      ),
    );

// A proof as staff start it: a platform_ops account asks for proof of the name.
const startNameProof = async (
  tx: Database,
  staffId: string,
  institutionId: string,
): Promise<void> => {
  await decideNameCheck(
    staffId,
    institutionId,
    { decision: "require_proof", reason: "Buktikan bahwa nama ini milik organisasi Anda." },
    tx,
  );
};

// Planted directly, for a Path B request that stays open under a proof: require_proof closes the
// pending Path B request, so no production path leaves one open under a proof except the race of
// the test "a Path B approval is refused after a closure".
const plantProof = async (tx: Database, institutionId: string): Promise<void> => {
  await tx
    .update(schema.institutions)
    .set({ nameProofDueAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000) })
    .where(eq(schema.institutions.id, institutionId));
};

describe.skipIf(skipWithoutDatabase)(
  "Path B and C requests, approvals and the staff override (real database)",
  () => {
    it("a Path B approval ticks the workspace and trusts its submitting owner", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx);
        const staffId = await seedStaff(tx);
        expect(await tierOf(tx, owner.ownerId)).toBe("minimal");

        const requested = await submit(tx, owner, {
          path: "instagram",
          instagramUrl: "https://instagram.com/Acme.Org",
        });
        expect(requested.status).toBe(201);
        expect(requested.body.documents).toEqual([]);
        const result = await approve(tx, staffId, requested.body.submissionId!);

        expect(result.trustedSubmitter).toBe(true);
        const [request] = await submissionRowsOf(tx, owner.institutionId);
        expect(request).toMatchObject({
          instagramUrl: "https://www.instagram.com/acme.org/",
          requestedPath: "instagram",
          targetInstitutionType: "company",
          emailDomainFlag: null,
        });
        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("instagram");
        expect(await tierOf(tx, owner.ownerId)).toBe("elevated");
        expect(await auditRowsOf(tx, owner.institutionId)).toHaveLength(1);
        expect((await auditRowsOf(tx, owner.institutionId))[0]?.toStatus).toBe("verified");
        expect(await raisedByTickRowsOf(tx, owner.ownerId)).toEqual([
          {
            actorUserId: staffId,
            targetUserId: owner.ownerId,
            eventType: "host_trust.raised_by_tick",
            metadata: {
              institutionId: owner.institutionId,
              submissionId: requested.body.submissionId,
              requestedPath: "instagram",
            },
          },
        ]);
      });
    });

    it("a Path C approval trusts nobody whose trust was removed, and nobody who left", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);

        // (1) A co-owner who did not submit is not trusted by the tick. It runs before the removal
        // below, because every account of this file signs up with one phone and would then match it.
        const submitter = await buildUntrustedOwner(tx);
        const bystander = await addCoOwner(tx, submitter);
        const submitterRequest = await submitDocuments(tx, submitter);

        const bystanderResult = await approve(tx, staffId, submitterRequest);

        expect(bystanderResult.trustedSubmitter).toBe(true);
        expect(await tierOf(tx, submitter.ownerId)).toBe("elevated");
        expect(await tierOf(tx, bystander)).toBe("minimal");

        // (2) The submitter's trust is removed before the approval.
        const trusted = await buildTickOwner(tx);
        expect(await tierOf(tx, trusted.ownerId)).toBe("elevated");
        const trustedRequest = await submitDocuments(tx, trusted);
        await removeHostTrust(staffId, trusted.ownerId, "Kepercayaan dicabut", tx);

        const removedResult = await approve(tx, staffId, trustedRequest);

        expect(removedResult.trustedSubmitter).toBe(false);
        const removedRow = await readWorkspace(tx, trusted.institutionId);
        expect(removedRow.verificationStatus).toBe("verified");
        expect(removedRow.tickPath).toBe("documents");
        expect(await tierOf(tx, trusted.ownerId)).toBe("minimal");
        expect(await raisedByTickRowsOf(tx, trusted.ownerId)).toEqual([]);

        // (3) The submitter, a co-owner who is otherwise eligible, left the workspace before the approval.
        const owner = await buildUntrustedOwner(tx);
        const leaver = await addCoOwner(tx, owner);
        const leaverRequest = await submitDocuments(tx, { ...owner, ownerId: leaver });
        const [membership] = await tx
          .select({ id: schema.institutionMemberships.id })
          .from(schema.institutionMemberships)
          .where(
            and(
              eq(schema.institutionMemberships.institutionId, owner.institutionId),
              eq(schema.institutionMemberships.userId, leaver),
            ),
          );
        await removeMember(owner.ownerId, owner.slug, membership!.id, tx);

        const leftResult = await approve(tx, staffId, leaverRequest);

        expect(leftResult.trustedSubmitter).toBe(false);
        expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe("verified");
        expect(await tierOf(tx, leaver)).toBe("minimal");
        expect(await raisedByTickRowsOf(tx, leaver)).toEqual([]);
      });
    });

    it("a Path C approval on a Path A tick switches the path and ends the name proof", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const switched = await buildTickOwner(tx);
        await tickByOrganizationDomain(switched.ownerId, switched.slug, tx);
        await startNameProof(tx, staffId, switched.institutionId);
        const request = await submitDocuments(tx, switched);
        const auditBefore = (await auditRowsOf(tx, switched.institutionId)).length;

        await approve(tx, staffId, request);

        const row = await readWorkspace(tx, switched.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("documents");
        expect(row.tickDomain).toBeNull();
        expect([row.nameProofDueAt, row.nameProofRemindedAt, row.nameCheckedAt]).toEqual([
          null,
          null,
          null,
        ]);
        const audit = await auditRowsOf(tx, switched.institutionId);
        expect(audit).toHaveLength(auditBefore + 1);
        expect(audit.at(-1)).toMatchObject({ fromStatus: "verified", toStatus: "verified" });

        // A Path B request that was filed before the proof started cannot be approved while it runs.
        const kept = await buildTickOwner(tx);
        await tickByOrganizationDomain(kept.ownerId, kept.slug, tx);
        const instagramRequest = await submitInstagram(tx, kept);
        await plantProof(tx, kept.institutionId);
        const planted = await readWorkspace(tx, kept.institutionId);

        const refused = await approve(tx, staffId, instagramRequest).then(
          () => null,
          (error: unknown) => error,
        );

        const after = await readWorkspace(tx, kept.institutionId);
        expect(after.tickPath).toBe("domain");
        expect(after.nameProofDueAt).toEqual(planted.nameProofDueAt);
        expect(after.nameProofRemindedAt).toEqual(planted.nameProofRemindedAt);
        const [pending] = await submissionRowsOf(tx, kept.institutionId);
        expect(pending?.status).toBe("pending_review");
        expect(refused).toBeInstanceOf(SubmissionError);
        expect(refused).toMatchObject({
          code: "institution_name_proof_needs_documents",
          status: 409,
        });
      });
    });

    it("the staff override writes the staff path and the revocation clears every tick column", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx, "personal");
        const staffId = await seedStaff(tx);

        await verifyInstitution({
          institutionId: owner.institutionId,
          targetStatus: "verified",
          actorUserId: staffId,
          db: tx,
        });
        const ticked = await readWorkspace(tx, owner.institutionId);
        expect(ticked.verificationStatus).toBe("verified");
        expect(ticked.tickPath).toBe("staff");

        await verifyInstitution({
          institutionId: owner.institutionId,
          targetStatus: "rejected",
          reason: "Pelanggaran",
          actorUserId: staffId,
          db: tx,
        });

        const revoked = await readWorkspace(tx, owner.institutionId);
        expect(revoked.verificationStatus).toBe("rejected");
        expect([
          revoked.tickPath,
          revoked.tickDomain,
          revoked.nameCheckedAt,
          revoked.nameProofDueAt,
          revoked.nameProofRemindedAt,
        ]).toEqual([null, null, null, null, null]);
        const audit = await auditRowsOf(tx, owner.institutionId);
        expect(audit.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual([
          "pending_verification->verified",
          "verified->rejected",
        ]);
      });
    });

    it("Path C stays closed for a personal workspace while Paths A and B are open", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx, "personal");

        const documents = await submit(tx, owner, { documents: COMPANY_DOCUMENTS });

        expect(documents.status).toBe(409);
        expect(documents.body.error?.code).toBe("institution_verification_not_applicable");
        expect(await submissionRowsOf(tx, owner.institutionId)).toEqual([]);

        const instagram = await submit(tx, owner, INSTAGRAM_REQUEST);

        expect(instagram.status).toBe(201);
        const rows = await submissionRowsOf(tx, owner.institutionId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "pending_review", requestedPath: "instagram" });
      });
    });

    it("a staff override closes a pending request and trusts its submitter", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx);
        const staffId = await seedStaff(tx);
        const requestId = await submitInstagram(tx, owner);

        await verifyInstitution({
          institutionId: owner.institutionId,
          targetStatus: "verified",
          actorUserId: staffId,
          db: tx,
        });

        expect((await readWorkspace(tx, owner.institutionId)).tickPath).toBe("staff");
        const [request] = await submissionRowsOf(tx, owner.institutionId);
        expect(request).toMatchObject({
          status: "approved",
          reviewerUserId: staffId,
          reviewerNotes: "Ditutup karena staf memberi centang langsung.",
        });
        expect(await tierOf(tx, owner.ownerId)).toBe("elevated");
        const raised = await raisedByTickRowsOf(tx, owner.ownerId);
        expect(raised).toHaveLength(1);
        expect(raised[0]?.metadata).toMatchObject({ closedByStaffOverride: true });

        const later = await refusalOf(approve(tx, staffId, requestId));
        expect(later).toBeInstanceOf(SubmissionError);
        expect(later).toMatchObject({ code: "submission_already_reviewed", status: 409 });
      });
    });

    it("a matched submitter is not trusted by the tick", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const removed = await buildTickOwner(tx);
        await removeHostTrust(staffId, removed.ownerId, "Hadiah tidak sesuai.", tx);
        const owner = await buildUntrustedOwner(tx);
        expect(await findRemovedHostMatch(tx, owner.ownerId)).toMatchObject({
          matchedBy: ["phone"],
        });
        const requestId = await submitInstagram(tx, owner);
        const queue = await listTickQueue(tx);
        expect(queue.requests.find((request) => request.submissionId === requestId)).toMatchObject({
          submissionId: requestId,
          submitterWouldBeTrusted: false,
        });

        const result = await approve(tx, staffId, requestId);

        expect(await tierOf(tx, owner.ownerId)).toBe("minimal");
        expect(await raisedByTickRowsOf(tx, owner.ownerId)).toEqual([]);
        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("instagram");
        expect(result.trustedSubmitter).toBe(false);
      });
    });

    it("a staff override closes a matched submitter's pending request and does not trust them", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const removed = await buildTickOwner(tx);
        await removeHostTrust(staffId, removed.ownerId, "Hadiah tidak sesuai.", tx);
        const owner = await buildUntrustedOwner(tx);
        await submitInstagram(tx, owner);

        await verifyInstitution({
          institutionId: owner.institutionId,
          targetStatus: "verified",
          actorUserId: staffId,
          db: tx,
        });

        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("staff");
        const [request] = await submissionRowsOf(tx, owner.institutionId);
        expect(request).toMatchObject({
          status: "approved",
          reviewerUserId: staffId,
          reviewerNotes: "Ditutup karena staf memberi centang langsung.",
        });
        expect(await tierOf(tx, owner.ownerId)).toBe("minimal");
        expect(await raisedByTickRowsOf(tx, owner.ownerId)).toEqual([]);
      });
    });

    it("an approval that would trust its submitter is refused without the hash key while a removal record exists", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const removed = await buildTickOwner(tx);
        await removeHostTrust(staffId, removed.ownerId, "Hadiah tidak sesuai.", tx);
        const owner = await buildUntrustedOwner(tx);
        const requestId = await submitInstagram(tx, owner);
        useHostIdentityKey(undefined);

        const refused = await approve(tx, staffId, requestId).then(
          () => null,
          (error: unknown) => error,
        );

        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("pending_verification");
        expect(row.tickPath).toBeNull();
        const [request] = await submissionRowsOf(tx, owner.institutionId);
        expect(request?.status).toBe("pending_review");
        expect(await auditRowsOf(tx, owner.institutionId)).toEqual([]);
        expect(await tierOf(tx, owner.ownerId)).toBe("minimal");
        expect(await raisedByTickRowsOf(tx, owner.ownerId)).toEqual([]);
        expect(refused).toBeInstanceOf(HostIdentityKeyError);
        expect((refused as HostIdentityKeyError).code).toBe("host_identity_key_missing");
      });
    });

    it("an approval needs no hash key when its submitter would not be trusted anyway", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const trusted = await buildTickOwner(tx);
        expect(await tierOf(tx, trusted.ownerId)).toBe("elevated");
        const removed = await buildTickOwner(tx);
        await removeHostTrust(staffId, removed.ownerId, "Hadiah tidak sesuai.", tx);
        // An eligible account in the transaction, so a read that drops the submitter's own id finds one.
        await buildUntrustedOwner(tx);
        const requestId = await submitDocuments(tx, trusted);
        useHostIdentityKey(undefined);

        const outcome = await approve(tx, staffId, requestId).then(
          (value) => value,
          (error: unknown) => error,
        );

        const row = await readWorkspace(tx, trusted.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("documents");
        expect(await tierOf(tx, trusted.ownerId)).toBe("elevated");
        expect(await raisedByTickRowsOf(tx, trusted.ownerId)).toEqual([]);
        expect(outcome).toMatchObject({ trustedSubmitter: false });
      });
    });

    it("the staff verify route refuses the automatic removal move", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await tickByOrganizationDomain(owner.ownerId, owner.slug, tx);
        const before = {
          row: await readWorkspace(tx, owner.institutionId),
          audit: await auditRowsOf(tx, owner.institutionId),
        };

        const refused = await refusalOf(
          verifyInstitution({
            institutionId: owner.institutionId,
            targetStatus: "pending_verification",
            actorUserId: staffId,
            db: tx,
          }),
        );

        expect(refused).toBeInstanceOf(VerificationError);
        expect(refused).toMatchObject({ code: "verification_invalid_transition", status: 409 });
        expect({
          row: await readWorkspace(tx, owner.institutionId),
          audit: await auditRowsOf(tx, owner.institutionId),
        }).toEqual(before);
      });
    });

    it("a Path B request is refused while a name proof runs", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        await tickByOrganizationDomain(owner.ownerId, owner.slug, tx);
        await startNameProof(tx, await seedStaff(tx), owner.institutionId);
        const beforeThePress = await readWorkspace(tx, owner.institutionId);

        const refused = await submit(tx, owner, INSTAGRAM_REQUEST);

        expect(refused.status).toBe(409);
        expect(refused.body.error?.code).toBe("institution_name_proof_needs_documents");
        expect(await submissionRowsOf(tx, owner.institutionId)).toEqual([]);
        const after = await readWorkspace(tx, owner.institutionId);
        expect(after.nameProofDueAt).toEqual(beforeThePress.nameProofDueAt);
        expect(after.nameProofRemindedAt).toEqual(beforeThePress.nameProofRemindedAt);

        const calm = await buildTickOwner(tx);
        await tickByOrganizationDomain(calm.ownerId, calm.slug, tx);

        const accepted = await submit(tx, calm, INSTAGRAM_REQUEST);

        expect(accepted.status).toBe(201);
        const rows = await submissionRowsOf(tx, calm.institutionId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "pending_review", requestedPath: "instagram" });
      });
    });

    it("each staff tick decision enqueues its notice after the commit", async () => {
      await inRollback(async (tx) => {
        const staffId = await seedStaff(tx);
        const spy = vi.mocked(enqueueInstitutionTickNotice);
        const noticesSoFar = () => spy.mock.calls.map(([call]) => call.payload);
        const forgetNotices = () => spy.mockClear();
        const verifyTo = (
          institutionId: string,
          targetStatus: "verified" | "rejected" | "under_review",
          reason?: string,
          actorUserId: string = staffId,
        ) => verifyInstitution({ institutionId, targetStatus, reason, actorUserId, db: tx });

        // A Path B approval.
        const approved = await buildUntrustedOwner(tx);
        const approvedRequest = await submitInstagram(tx, approved);
        forgetNotices();
        await approve(tx, staffId, approvedRequest);
        expect(noticesSoFar()).toEqual([
          {
            institutionId: approved.institutionId,
            kind: "tick_granted",
            epoch: expect.any(Number),
          },
        ]);

        // A Path C turn-down with notes N, then with no notes.
        const turnedDown = await buildUntrustedOwner(tx);
        const withNotes = await submitDocuments(tx, turnedDown);
        forgetNotices();
        await reviewVerificationSubmission(withNotes, "rejected", "Dokumen buram.", staffId, tx);
        expect(noticesSoFar()).toEqual([
          {
            institutionId: turnedDown.institutionId,
            kind: "tick_request_turned_down",
            reason: "Dokumen buram.",
            epoch: expect.any(Number),
          },
        ]);

        const withoutNotes = await submitDocuments(tx, turnedDown);
        forgetNotices();
        await reviewVerificationSubmission(withoutNotes, "rejected", null, staffId, tx);
        expect(noticesSoFar()).toHaveLength(1);
        expect(noticesSoFar()[0]).toMatchObject({ kind: "tick_request_turned_down" });
        expect(noticesSoFar()[0]).not.toHaveProperty("reason");

        // A direct staff tick.
        const direct = await buildUntrustedOwner(tx);
        forgetNotices();
        await verifyTo(direct.institutionId, "verified");
        expect(noticesSoFar()).toEqual([
          { institutionId: direct.institutionId, kind: "tick_granted", epoch: expect.any(Number) },
        ]);

        // A revocation of a Path A tick.
        const revoked = await buildTickOwner(tx);
        await tickByOrganizationDomain(revoked.ownerId, revoked.slug, tx);
        forgetNotices();
        await verifyTo(revoked.institutionId, "rejected", "Pengaduan dari institusi resmi.");
        expect(noticesSoFar()).toEqual([
          {
            institutionId: revoked.institutionId,
            kind: "tick_revoked",
            reason: "Pengaduan dari institusi resmi.",
            epoch: expect.any(Number),
          },
        ]);

        // A denial of a workspace that never had a tick.
        const denied = await buildUntrustedOwner(tx);
        forgetNotices();
        await verifyTo(denied.institutionId, "rejected", "Data tidak lengkap.");
        expect(noticesSoFar()).toEqual([
          {
            institutionId: denied.institutionId,
            kind: "tick_request_turned_down",
            reason: "Data tidak lengkap.",
            epoch: expect.any(Number),
          },
        ]);

        // A move to under_review notifies nobody.
        const reviewing = await buildUntrustedOwner(tx);
        forgetNotices();
        await verifyTo(reviewing.institutionId, "under_review");
        expect(noticesSoFar()).toEqual([]);

        // A refused decision of either service enqueues nothing.
        const conflicted = await buildUntrustedOwner(tx);
        const conflictedRequest = await submitInstagram(tx, conflicted);
        const operatorWithMembership = await seedStaff(tx);
        await tx.insert(schema.institutionMemberships).values({
          institutionId: conflicted.institutionId,
          userId: operatorWithMembership,
          membershipRole: "institution_member",
          status: "active",
        });
        forgetNotices();
        const refusedVerify = await refusalOf(
          verifyTo(conflicted.institutionId, "verified", undefined, operatorWithMembership),
        );
        const refusedReview = await refusalOf(
          approve(tx, operatorWithMembership, conflictedRequest),
        );
        expect(refusedVerify).toMatchObject({ code: "operator_actor_conflicted", status: 403 });
        expect(refusedReview).toMatchObject({ code: "operator_actor_conflicted", status: 403 });
        expect(noticesSoFar()).toEqual([]);

        // A notice that cannot be enqueued never undoes the approval.
        const failing = await buildUntrustedOwner(tx);
        const failingRequest = await submitInstagram(tx, failing);
        forgetNotices();
        spy.mockRejectedValueOnce(new Error("redis down"));
        const result = await approve(tx, staffId, failingRequest);
        expect(result.status).toBe("approved");
        expect((await readWorkspace(tx, failing.institutionId)).verificationStatus).toBe(
          "verified",
        );
      });
    });

    it("the submit body's path is a closed set", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx);
        const instagramUrl = "https://instagram.com/acme.org";
        const bodies = [
          { path: "other", documents: COMPANY_DOCUMENTS },
          { path: "documents", documents: COMPANY_DOCUMENTS, instagramUrl },
          { path: "domain", instagramUrl },
          { path: "staff", instagramUrl },
        ];

        for (const body of bodies) {
          const answer = await submit(tx, owner, body);

          expect(await submissionRowsOf(tx, owner.institutionId)).toEqual([]);
          expect(answer.status).toBe(400);
          expect(answer.body.error?.code).toBe("verification_invalid_payload");
        }
      });
    });

    it("a Path B request with a link that is not an Instagram profile is refused", async () => {
      await inRollback(async (tx) => {
        const owner = await buildUntrustedOwner(tx);

        for (const instagramUrl of [
          "https://example.com/acme",
          "https://instagram.com/",
          "https://www.instagram.com/a-b",
        ]) {
          const answer = await submit(tx, owner, { path: "instagram", instagramUrl });

          expect(answer.status).toBe(400);
          expect(answer.body.error?.code).toBe("institution_tick_instagram_invalid");
        }

        expect(await submissionRowsOf(tx, owner.institutionId)).toEqual([]);
      });
    });
  },
);

// ── Committed rows: a proof request that commits while the owner files a Path B request ──────

type Connection = {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (): Connection => {
  const connection = postgres(TEST_DATABASE_URL!, { max: 1, idle_timeout: 0 });
  return { sql: connection, db: drizzle(connection, { schema }) };
};

const asDatabase = (connection: Connection): Database => connection.db as unknown as Database;

const NO_WAIT_TIMEOUT_MS = 5_000;

// Fails when `work` has not finished in time, which here means it queued behind a lock it must not
// wait on.
const mustNotWait = async <T>(work: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} waited on the row lock the holder keeps`)),
      NO_WAIT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// Runs `holdWork` in a transaction on `holder` and keeps it open while `during` runs, then commits.
const holdTransactionWhile = async <T>(
  holder: Connection,
  holdWork: (tx: Database) => Promise<unknown>,
  during: () => Promise<T>,
): Promise<T> => {
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

  try {
    return await during();
  } finally {
    release();
    await holding.catch(() => undefined);
  }
};

describe.skipIf(skipWithoutDatabase)(
  "a name proof that commits while a Path B request is filed (committed rows)",
  () => {
    const createdUserIds: string[] = [];
    const createdInstitutionIds: string[] = [];
    let control: Connection;
    let holder: Connection;
    let racer: Connection;

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

    it("a Path B approval is refused after a closure", async () => {
      try {
        const database = asDatabase(control);
        const owner = await buildTickOwner(database);
        createdUserIds.push(owner.ownerId);
        createdInstitutionIds.push(owner.institutionId);
        const staffId = await seedStaff(database);
        createdUserIds.push(staffId);
        await tickByOrganizationDomain(owner.ownerId, owner.slug, database);

        // The race: the staff request for proof is held open, and the owner files a Path B request
        // on a second connection. The submit takes no row lock, so it does not wait, and it reads a
        // workspace with no proof. The request for proof then commits.
        const filed = await holdTransactionWhile(
          holder,
          (tx) =>
            decideNameCheck(
              staffId,
              owner.institutionId,
              {
                decision: "require_proof",
                reason: "Buktikan bahwa nama ini milik organisasi Anda.",
              },
              tx,
            ),
          () =>
            mustNotWait(submit(asDatabase(racer), owner, INSTAGRAM_REQUEST), "the Path B submit"),
        );

        expect(filed.status).toBe(201);
        const requestId = filed.body.submissionId!;
        const [pending] = await submissionRowsOf(database, owner.institutionId);
        expect(pending).toMatchObject({ id: requestId, status: "pending_review" });
        expect((await readWorkspace(database, owner.institutionId)).nameProofDueAt).not.toBeNull();

        const rename = await callRoute(
          database,
          settingsRoute,
          owner.ownerId,
          owner.slug,
          "PATCH",
          {
            displayName: `Nama Baru ${freshPart()}`,
            acknowledgeTickRemoval: true,
          },
        );
        expect(rename.status).toBe(200);
        expect((await auditRowsOf(database, owner.institutionId)).at(-1)?.reason).toBe(
          "Nama ruang kerja diubah selama bukti nama berjalan.",
        );

        const refused = await refusalOf(approve(database, staffId, requestId));

        expect(refused).toBeInstanceOf(SubmissionError);
        expect(refused).toMatchObject({
          code: "institution_tick_closed_needs_documents",
          status: 409,
          details: { cause: "automatic", closedInstitutionId: owner.institutionId },
        });
        const row = await readWorkspace(database, owner.institutionId);
        expect(row.verificationStatus).toBe("pending_verification");
        expect([
          row.tickPath,
          row.tickDomain,
          row.nameCheckedAt,
          row.nameProofDueAt,
          row.nameProofRemindedAt,
        ]).toEqual([null, null, null, null, null]);
        const [stillPending] = await submissionRowsOf(database, owner.institutionId);
        expect(stillPending?.status).toBe("pending_review");
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);
  },
);
