// @vitest-environment node

// Path A, the closure and the removal of a tick by a website change or a rename, against real rows.
// Accounts come through the real sign-up, code verification and host step services, the Email
// organisasi through its real code services, workspaces and invitations through their services, and
// every owner action through the real route handler with the Rule 16 header. A row is planted
// directly only where no service writes that state, and each place says why.
//
// The last describe COMMITS, because one connection cannot wait on itself: a second connection holds
// a row lock the service under test is expected to wait on. Every committed row is deleted by id in a
// finally, and what survived is asserted.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, asc, eq, inArray, sql } from "drizzle-orm";
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
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createInstitutionWorkspaceForUser,
  loadInstitutionVerificationSummaryBySlug,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  createInstitutionInvitation,
  acceptInstitutionInvitationForUser,
} from "@/server/institution-invitations/invitation-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import { removeHostTrust } from "@/server/host-trust/host-trust-removal-service";
import { suspendInstitution } from "@/server/moderation/moderation-service";
import {
  createInstagramTickRequest,
  reviewVerificationSubmission,
  SubmissionError,
} from "./submission-service";
import { decideNameCheck } from "./name-check-service";
import { readTickPageState, tickByOrganizationDomain } from "./tick-service";
import { verifyInstitution } from "./verification-service";
import { VerificationError } from "./verification-core";
import {
  createCompetitionDraft,
  transitionCompetitionStatus,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { setCompetitionFee } from "@/server/competitions/competition-fee-service";
import { createPayment } from "@/server/finance/payment-service";
import { POST as domainRoute } from "@/app/api/v1/institutions/[institutionSlug]/tick/domain/route";
import { POST as submitRoute } from "@/app/api/v1/institutions/[institutionSlug]/verification/submit/route";
import { PATCH as profileRoute } from "@/app/api/v1/institutions/[institutionSlug]/profile/route";
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

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
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

const organizationEmailFor = (domain: string): string => `budi.${freshPart()}@${domain}`;

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

const saveWebsite = async (
  tx: Database,
  ownerId: string,
  slug: string,
  websiteUrl: string | null,
): Promise<void> => {
  await updateInstitutionProfileForOwnerBySlug(ownerId, slug, { websiteUrl }, tx);
};

type TickOwner = Workspace & { ownerId: string; organizationEmail: string | null };

// The Path A owner: signed up, host step taken, Email organisasi confirmed (which trusts the
// account), workspace created and its website saved.
const buildTickOwner = async (
  tx: Database,
  options: {
    organizationDomain?: string | null;
    website?: string | null;
    institutionType?: "company" | "personal";
  } = {},
): Promise<TickOwner> => {
  const organizationDomain =
    options.organizationDomain === undefined ? "students.acme.example" : options.organizationDomain;
  const ownerId = await signUpHost(tx, "pemilik");
  const organizationEmail =
    organizationDomain === null ? null : organizationEmailFor(organizationDomain);
  if (organizationEmail !== null) await confirmOrganizationEmail(tx, ownerId, organizationEmail);

  const workspace = await createWorkspace(tx, ownerId, options.institutionType);
  const website = options.website === undefined ? "https://www.acme.example" : options.website;
  if (website !== null) await saveWebsite(tx, ownerId, workspace.slug, website);
  return { ...workspace, ownerId, organizationEmail };
};

const addMember = async (
  tx: Database,
  owner: TickOwner,
  role: "institution_owner" | "institution_staff" | "institution_member",
  organizationDomain: string | null = "students.acme.example",
): Promise<{ userId: string; organizationEmail: string | null }> => {
  const userId = await signUpHost(tx, "anggota");
  const organizationEmail =
    organizationDomain === null ? null : organizationEmailFor(organizationDomain);
  if (organizationEmail !== null) await confirmOrganizationEmail(tx, userId, organizationEmail);

  const invitation = await createInstitutionInvitation(
    owner.ownerId,
    owner.slug,
    { invitedIdentifier: await usernameOf(tx, userId), invitedRole: role },
    tx,
  );
  await acceptInstitutionInvitationForUser(invitation.id, userId, ["candidate", "recruiter"], tx);
  return { userId, organizationEmail };
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
) => Promise<Response>;

type RouteAnswer = {
  status: number;
  body: {
    error?: { code: string; details?: { cause?: string; closedInstitutionId?: string } };
    institution?: Record<string, unknown>;
    submissionId?: string;
    documents?: unknown[];
  };
};

const callRoute = async (
  tx: Database,
  handler: RouteHandler,
  actorUserId: string,
  slug: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<RouteAnswer> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const response = await handler(
    new Request(`http://localhost/api/v1/institutions/${slug}`, {
      method,
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: actorUserId },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionSlug: slug }) },
  );
  return { status: response.status, body: await response.json() };
};

const pressPathA = (tx: Database, actorUserId: string, slug: string) =>
  callRoute(tx, domainRoute, actorUserId, slug, "POST");

const patchProfile = (
  tx: Database,
  actorUserId: string,
  slug: string,
  body: Record<string, unknown>,
) => callRoute(tx, profileRoute, actorUserId, slug, "PATCH", body);

const patchSettings = (
  tx: Database,
  actorUserId: string,
  slug: string,
  body: Record<string, unknown>,
) => callRoute(tx, settingsRoute, actorUserId, slug, "PATCH", body);

const submit = (tx: Database, actorUserId: string, slug: string, body: Record<string, unknown>) =>
  callRoute(tx, submitRoute, actorUserId, slug, "POST", body);

const COMPANY_DOCUMENTS = ["npwp", "nib"].map((documentType) => ({
  documentType,
  originalFileName: `${documentType}.pdf`,
  fileSizeBytes: 1024,
  contentType: "application/pdf",
}));

const INSTAGRAM_REQUEST = { path: "instagram", instagramUrl: "https://instagram.com/acme.org" };

const submitDocuments = async (tx: Database, owner: TickOwner): Promise<string> => {
  const answer = await submit(tx, owner.ownerId, owner.slug, { documents: COMPANY_DOCUMENTS });
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const approve = (tx: Database, staffId: string, submissionId: string) =>
  reviewVerificationSubmission(submissionId, "approved", null, staffId, tx);

// A Path C approval: the way a workspace is ticked by documents.
const tickByDocuments = async (tx: Database, owner: TickOwner, staffId: string): Promise<void> => {
  await approve(tx, staffId, await submitDocuments(tx, owner));
};

const revoke = (tx: Database, staffId: string, institutionId: string) =>
  verifyInstitution({
    institutionId,
    targetStatus: "rejected",
    reason: "Pelanggaran",
    actorUserId: staffId,
    db: tx,
  });

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
      websiteUrl: schema.institutions.websiteUrl,
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

const submissionRowsOf = (tx: Database, institutionId: string) =>
  tx
    .select({
      id: schema.institutionVerificationSubmissions.id,
      status: schema.institutionVerificationSubmissions.status,
      requestedPath: schema.institutionVerificationSubmissions.requestedPath,
      reviewerUserId: schema.institutionVerificationSubmissions.reviewerUserId,
      reviewerNotes: schema.institutionVerificationSubmissions.reviewerNotes,
      reviewedAt: schema.institutionVerificationSubmissions.reviewedAt,
    })
    .from(schema.institutionVerificationSubmissions)
    .where(eq(schema.institutionVerificationSubmissions.institutionId, institutionId))
    .orderBy(asc(schema.institutionVerificationSubmissions.submittedAt));

// "No row change": the status, the five tick columns and the audit rows of the workspace.
const snapshotOf = async (tx: Database, institutionId: string) => {
  const row = await readWorkspace(tx, institutionId);
  return {
    verificationStatus: row.verificationStatus,
    tickPath: row.tickPath,
    tickDomain: row.tickDomain,
    nameCheckedAt: row.nameCheckedAt,
    nameProofDueAt: row.nameProofDueAt,
    nameProofRemindedAt: row.nameProofRemindedAt,
    auditRows: (await auditRowsOf(tx, institutionId)).length,
  };
};

const expectRefusal = (
  answer: RouteAnswer,
  status: number,
  code: string,
  cause?: "staff" | "automatic",
): void => {
  expect(answer.status).toBe(status);
  expect(answer.body.error?.code).toBe(code);
  if (cause !== undefined) expect(answer.body.error?.details?.cause).toBe(cause);
};

// A proof as staff start it: a platform_ops account asks for proof of the name.
const startNameProof = async (tx: Database, institutionId: string): Promise<void> => {
  await decideNameCheck(
    await seedStaff(tx),
    institutionId,
    { decision: "require_proof", reason: "Buktikan bahwa nama ini milik organisasi Anda." },
    tx,
  );
};

// Planted directly, for the one test that sets a reminder date a service never writes.
const plantProof = async (tx: Database, institutionId: string, remindedAt: Date | null) => {
  await tx
    .update(schema.institutions)
    .set({ nameProofDueAt: sql`now() + interval '20 days'`, nameProofRemindedAt: remindedAt })
    .where(eq(schema.institutions.id, institutionId));
};

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(skipWithoutDatabase)(
  "Path A, the closure and the tick removal (real database)",
  () => {
    it("Path A ticks a workspace whose owner's Email organisasi domain matches its website", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expect(answer.status).toBe(200);
        expect(answer.body.institution).toEqual({
          id: owner.institutionId,
          verificationStatus: "verified",
          tickPath: "domain",
        });
        expect(answer.body.institution).not.toHaveProperty("tickDomain");
        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("domain");
        expect(row.tickDomain).toBe("acme.example");
        expect(row.nameCheckedAt).toBeNull();
        expect(await auditRowsOf(tx, owner.institutionId)).toEqual([
          {
            fromStatus: "pending_verification",
            toStatus: "verified",
            reason: "tick_path_a_domain",
            actorUserId: owner.ownerId,
          },
        ]);
      });
    });

    it("Path A refuses a staff member, a member and another workspace's owner", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffMember = await addMember(tx, owner, "institution_staff");
        const member = await addMember(tx, owner, "institution_member");
        const otherOwner = await signUpHost(tx, "lain");
        await confirmOrganizationEmail(
          tx,
          otherOwner,
          organizationEmailFor("students.acme.example"),
        );
        await createWorkspace(tx, otherOwner);
        const before = await snapshotOf(tx, owner.institutionId);

        for (const actorId of [staffMember.userId, member.userId, otherOwner]) {
          const answer = await pressPathA(tx, actorId, owner.slug);
          expectRefusal(answer, 403, "forbidden");
        }

        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    const refusedCases: Array<{
      label: string;
      organizationDomain: string | null;
      website: string | null;
      code: string;
      status: number;
    }> = [
      {
        label: "another organization's website",
        organizationDomain: "students.acme.example",
        website: "https://other.example",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "a generic com second-level name",
        organizationDomain: "x.com.example",
        website: "https://y.com.example",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "a generic ne second-level name",
        organizationDomain: "docomo.ne.example",
        website: "https://other.ne.example",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "a generic gob second-level name",
        organizationDomain: "x.gob.example",
        website: "https://y.gob.example",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "an IPv4 website host",
        organizationDomain: "students.acme.example",
        website: "https://9.9.3.4",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "a bracketed IPv6 website host",
        organizationDomain: "students.acme.example",
        website: "https://[2001:db8::1]",
        code: "institution_tick_domain_mismatch",
        status: 422,
      },
      {
        label: "no Email organisasi",
        organizationDomain: null,
        website: "https://www.acme.example",
        code: "institution_tick_no_organization_email",
        status: 422,
      },
      {
        label: "no website",
        organizationDomain: "students.acme.example",
        website: null,
        code: "institution_tick_no_website",
        status: 422,
      },
    ];

    it("Path A refuses a mismatched or generic domain", async () => {
      await inRollback(async (tx) => {
        for (const { organizationDomain, website, code, status } of refusedCases) {
          const owner = await buildTickOwner(tx, { organizationDomain, website });
          const before = await snapshotOf(tx, owner.institutionId);

          const answer = await pressPathA(tx, owner.ownerId, owner.slug);

          expectRefusal(answer, status, code);
          expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
        }

        // The sign-up accepts an address that is another account's Email organisasi, which is the
        // case the sign-in predicate exists for.
        const owner = await buildTickOwner(tx);
        const before = await snapshotOf(tx, owner.institutionId);
        await signUpParticipant(tx, owner.organizationEmail!);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expectRefusal(answer, 422, "institution_tick_no_organization_email");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("Path A refuses an owner whose trust staff removed", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await removeHostTrust(staffId, owner.ownerId, "Kepercayaan dicabut", tx);
        const before = await snapshotOf(tx, owner.institutionId);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expectRefusal(answer, 403, "institution_tick_owner_trust_removed");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("changing a ticked workspace's website to another organization removes the tick, and only after acknowledgement", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        await pressPathA(tx, owner.ownerId, owner.slug);

        const unconfirmed = await patchProfile(tx, owner.ownerId, owner.slug, {
          websiteUrl: "https://other.example",
        });

        expectRefusal(unconfirmed, 409, "institution_tick_removal_unconfirmed");
        const unchanged = await readWorkspace(tx, owner.institutionId);
        expect(unchanged.websiteUrl).toBe("https://www.acme.example");
        expect(unchanged.verificationStatus).toBe("verified");

        const confirmed = await patchProfile(tx, owner.ownerId, owner.slug, {
          websiteUrl: "https://other.example",
          acknowledgeTickRemoval: true,
        });

        expect(confirmed.status).toBe(200);
        const removed = await readWorkspace(tx, owner.institutionId);
        expect(removed.websiteUrl).toBe("https://other.example");
        expect(removed.verificationStatus).toBe("pending_verification");
        expect([
          removed.tickPath,
          removed.tickDomain,
          removed.nameCheckedAt,
          removed.nameProofDueAt,
          removed.nameProofRemindedAt,
        ]).toEqual([null, null, null, null, null]);
        const audit = await auditRowsOf(tx, owner.institutionId);
        expect(audit.at(-1)).toEqual({
          fromStatus: "verified",
          toStatus: "pending_verification",
          reason: "Situs web diubah.",
          actorUserId: owner.ownerId,
        });

        const sameOrganization = await buildTickOwner(tx);
        await pressPathA(tx, sameOrganization.ownerId, sameOrganization.slug);
        const withinOrganization = await patchProfile(
          tx,
          sameOrganization.ownerId,
          sameOrganization.slug,
          { websiteUrl: "https://acme.example/" },
        );
        expect(withinOrganization.status).toBe(200);
        const keptDomainTick = await readWorkspace(tx, sameOrganization.institutionId);
        expect(keptDomainTick.verificationStatus).toBe("verified");
        expect(keptDomainTick.tickPath).toBe("domain");

        // A documents tick compares the host, not the organization domain: portal.cerdas.example
        // shares cerdas.example with www.cerdas.example and still removes the tick.
        const staffId = await seedStaff(tx);
        const changed = await buildTickOwner(tx, {
          organizationDomain: null,
          website: "https://www.cerdas.example",
        });
        await tickByDocuments(tx, changed, staffId);
        expect((await readWorkspace(tx, changed.institutionId)).tickPath).toBe("documents");

        const removal = await patchProfile(tx, changed.ownerId, changed.slug, {
          websiteUrl: "https://portal.cerdas.example",
          acknowledgeTickRemoval: true,
        });

        expect(removal.status).toBe(200);
        const removedDocumentsTick = await readWorkspace(tx, changed.institutionId);
        expect(removedDocumentsTick.verificationStatus).toBe("pending_verification");
        expect(removedDocumentsTick.tickPath).toBeNull();
        expect((await auditRowsOf(tx, changed.institutionId)).at(-1)?.reason).toBe(
          "Situs web diubah.",
        );

        const kept = await buildTickOwner(tx, {
          organizationDomain: null,
          website: "https://www.cerdas.example",
        });
        await tickByDocuments(tx, kept, staffId);

        const sameHost = await patchProfile(tx, kept.ownerId, kept.slug, {
          websiteUrl: "https://cerdas.example",
        });

        expect(sameHost.status).toBe(200);
        const keptRow = await readWorkspace(tx, kept.institutionId);
        expect(keptRow.verificationStatus).toBe("verified");
        expect(keptRow.tickPath).toBe("documents");
      });
    });

    it("renaming a ticked workspace removes the tick, a slug change alone keeps it", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        await pressPathA(tx, owner.ownerId, owner.slug);
        const newName = `Nama Baru ${freshPart()}`;

        const unconfirmed = await patchSettings(tx, owner.ownerId, owner.slug, {
          displayName: newName,
        });

        expectRefusal(unconfirmed, 409, "institution_tick_removal_unconfirmed");
        const unchanged = await readWorkspace(tx, owner.institutionId);
        expect(unchanged.displayName).not.toBe(newName);
        expect(unchanged.verificationStatus).toBe("verified");

        const confirmed = await patchSettings(tx, owner.ownerId, owner.slug, {
          displayName: newName,
          acknowledgeTickRemoval: true,
        });

        expect(confirmed.status).toBe(200);
        const removed = await readWorkspace(tx, owner.institutionId);
        expect(removed.verificationStatus).toBe("pending_verification");
        expect([
          removed.tickPath,
          removed.tickDomain,
          removed.nameCheckedAt,
          removed.nameProofDueAt,
          removed.nameProofRemindedAt,
        ]).toEqual([null, null, null, null, null]);
        expect((await auditRowsOf(tx, owner.institutionId)).at(-1)).toEqual({
          fromStatus: "verified",
          toStatus: "pending_verification",
          reason: "Nama ruang kerja diubah.",
          actorUserId: owner.ownerId,
        });

        const slugOwner = await buildTickOwner(tx);
        await pressPathA(tx, slugOwner.ownerId, slugOwner.slug);
        const staffId = await seedStaff(tx);
        await decideNameCheck(staffId, slugOwner.institutionId, { decision: "name_ok" }, tx);

        const slugChange = await patchSettings(tx, slugOwner.ownerId, slugOwner.slug, {
          slug: `alamat-baru-${freshPart()}`,
        });

        expect(slugChange.status).toBe(200);
        const kept = await readWorkspace(tx, slugOwner.institutionId);
        expect(kept.verificationStatus).toBe("verified");
        expect(kept.tickPath).toBe("domain");
        expect(kept.nameCheckedAt).toBeNull();
        expect((await auditRowsOf(tx, slugOwner.institutionId)).at(-1)).toEqual({
          fromStatus: "verified",
          toStatus: "verified",
          reason: "Alamat ruang kerja diubah.",
          actorUserId: slugOwner.ownerId,
        });
      });
    });

    // The sweep half of the proof is not built yet, so this asserts the columns a slug change leaves.
    it("a slug change during a proof keeps it, and day 29 still removes", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        await pressPathA(tx, owner.ownerId, owner.slug);
        const remindedAt = new Date(Date.now() - DAY_MS);
        await plantProof(tx, owner.institutionId, remindedAt);
        const planted = await readWorkspace(tx, owner.institutionId);

        const answer = await patchSettings(tx, owner.ownerId, owner.slug, {
          slug: `alamat-baru-${freshPart()}`,
        });

        expect(answer.status).toBe(200);
        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("domain");
        expect(row.nameProofDueAt).toEqual(planted.nameProofDueAt);
        expect(row.nameProofRemindedAt).toEqual(planted.nameProofRemindedAt);
        expect(row.nameCheckedAt).toBeNull();
      });
    });

    it("Path A closes a pending request", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const requested = await submit(tx, owner.ownerId, owner.slug, INSTAGRAM_REQUEST);
        expect(requested.status).toBe(201);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expect(answer.status).toBe(200);
        const row = await readWorkspace(tx, owner.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.tickPath).toBe("domain");
        const [request] = await submissionRowsOf(tx, owner.institutionId);
        expect(request?.status).toBe("rejected");
        expect(request?.reviewerUserId).toBeNull();
        expect(request?.reviewedAt).not.toBeNull();
        expect(request?.reviewerNotes).toBe(
          "Ditutup karena centang sudah didapat lewat email organisasi.",
        );
        expect(await auditRowsOf(tx, owner.institutionId)).toHaveLength(1);
      });
    });

    it("a typed slug that starts with deleted- is refused", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);

        const answer = await patchSettings(tx, owner.ownerId, owner.slug, { slug: "deleted-abc" });

        expectRefusal(answer, 422, "institution_slug_reserved");
        expect((await readWorkspace(tx, owner.institutionId)).slug).toBe(owner.slug);
      });
    });

    it("Path A does not count another owner's Email organisasi", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const secondOwner = await addMember(tx, owner, "institution_owner", null);
        const before = await snapshotOf(tx, owner.institutionId);

        const answer = await pressPathA(tx, secondOwner.userId, owner.slug);

        expectRefusal(answer, 422, "institution_tick_no_organization_email");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("Path A refuses a suspended workspace", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await suspendInstitution(staffId, owner.institutionId, "Pelanggaran", tx);
        const before = await snapshotOf(tx, owner.institutionId);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expectRefusal(answer, 403, "institution_suspended");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("Path A refuses a workspace already ticked", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await tickByDocuments(tx, owner, staffId);
        const before = await snapshotOf(tx, owner.institutionId);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expectRefusal(answer, 409, "institution_already_verified");
        expect((await readWorkspace(tx, owner.institutionId)).tickPath).toBe("documents");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("Path A and Path B stay closed after a staff revocation", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await pressPathA(tx, owner.ownerId, owner.slug);
        const requested = await submit(tx, owner.ownerId, owner.slug, INSTAGRAM_REQUEST);
        expect(requested.status).toBe(201);

        await revoke(tx, staffId, owner.institutionId);

        const [closedRequest] = await submissionRowsOf(tx, owner.institutionId);
        expect(closedRequest?.status).toBe("rejected");
        expect(closedRequest?.reviewerUserId).toBe(staffId);
        expect(closedRequest?.reviewerNotes).toBe(
          "Ditutup karena centang ruang kerja dicabut atau ditolak staf. Centang hanya dapat didapat lagi lewat dokumen.",
        );
        const afterRevocation = await snapshotOf(tx, owner.institutionId);

        const pathA = await pressPathA(tx, owner.ownerId, owner.slug);
        expectRefusal(pathA, 409, "institution_tick_path_a_closed", "staff");
        expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe("rejected");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(afterRevocation);

        const pathB = await submit(tx, owner.ownerId, owner.slug, INSTAGRAM_REQUEST);
        expectRefusal(pathB, 409, "institution_tick_closed_needs_documents", "staff");
        expect(await submissionRowsOf(tx, owner.institutionId)).toHaveLength(1);

        await tickByDocuments(tx, owner, staffId);
        const restored = await readWorkspace(tx, owner.institutionId);
        expect(restored.verificationStatus).toBe("verified");
        expect(restored.tickPath).toBe("documents");

        const websiteChange = await patchProfile(tx, owner.ownerId, owner.slug, {
          websiteUrl: "https://portal.acme.example",
          acknowledgeTickRemoval: true,
        });
        expect(websiteChange.status).toBe(200);
        expect((await auditRowsOf(tx, owner.institutionId)).at(-1)?.reason).toBe(
          "Situs web diubah.",
        );

        const againPathA = await pressPathA(tx, owner.ownerId, owner.slug);
        expect(againPathA.status).toBe(200);
        const ticked = await readWorkspace(tx, owner.institutionId);
        expect(ticked.verificationStatus).toBe("verified");
        expect(ticked.tickPath).toBe("domain");
      });
    });

    it("Path A stays closed after a rename or website change made during a name proof", async () => {
      await inRollback(async (tx) => {
        const renamed = await buildTickOwner(tx);
        await pressPathA(tx, renamed.ownerId, renamed.slug);
        await startNameProof(tx, renamed.institutionId);

        const rename = await patchSettings(tx, renamed.ownerId, renamed.slug, {
          displayName: `Nama Baru ${freshPart()}`,
          acknowledgeTickRemoval: true,
        });

        expect(rename.status).toBe(200);
        expect((await readWorkspace(tx, renamed.institutionId)).verificationStatus).toBe(
          "pending_verification",
        );
        expect((await auditRowsOf(tx, renamed.institutionId)).at(-1)?.reason).toBe(
          "Nama ruang kerja diubah selama bukti nama berjalan.",
        );
        expectRefusal(
          await pressPathA(tx, renamed.ownerId, renamed.slug),
          409,
          "institution_tick_path_a_closed",
          "automatic",
        );

        const moved = await buildTickOwner(tx);
        await pressPathA(tx, moved.ownerId, moved.slug);
        await startNameProof(tx, moved.institutionId);

        const websiteChange = await patchProfile(tx, moved.ownerId, moved.slug, {
          websiteUrl: "https://other.example",
          acknowledgeTickRemoval: true,
        });

        expect(websiteChange.status).toBe(200);
        expect((await auditRowsOf(tx, moved.institutionId)).at(-1)?.reason).toBe(
          "Situs web diubah selama bukti nama berjalan.",
        );
        expectRefusal(
          await pressPathA(tx, moved.ownerId, moved.slug),
          409,
          "institution_tick_path_a_closed",
          "automatic",
        );

        const calm = await buildTickOwner(tx);
        await pressPathA(tx, calm.ownerId, calm.slug);
        await patchSettings(tx, calm.ownerId, calm.slug, {
          displayName: `Nama Baru ${freshPart()}`,
          acknowledgeTickRemoval: true,
        });

        const again = await pressPathA(tx, calm.ownerId, calm.slug);

        expect(again.status).toBe(200);
        const row = await readWorkspace(tx, calm.institutionId);
        expect(row.verificationStatus).toBe("verified");
        expect(row.nameCheckedAt).toBeNull();
      });
    });

    it("Path A and Path B refuse while a paid competition is live", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await tickByDocuments(tx, owner, staffId);
        const competitionId = await publishPaidCompetition(tx, owner);

        const rename = await patchSettings(tx, owner.ownerId, owner.slug, {
          displayName: `Nama Baru ${freshPart()}`,
          acknowledgeTickRemoval: true,
        });
        expect(rename.status).toBe(200);
        expect((await auditRowsOf(tx, owner.institutionId)).at(-1)?.reason).toBe(
          "Nama ruang kerja diubah.",
        );
        const afterRename = await snapshotOf(tx, owner.institutionId);

        const pathA = await pressPathA(tx, owner.ownerId, owner.slug);
        expectRefusal(pathA, 409, "institution_tick_live_paid_competition");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(afterRename);

        await expect(
          createPaymentForNewRegistration(tx, owner, competitionId),
        ).rejects.toMatchObject({
          code: "competition_institution_not_verified",
          httpStatus: 422,
        });

        const pathB = await submit(tx, owner.ownerId, owner.slug, INSTAGRAM_REQUEST);
        expectRefusal(pathB, 409, "institution_tick_live_paid_competition");
        const rowsBefore = (await submissionRowsOf(tx, owner.institutionId)).length;

        // Planted by an insert: the submit refuses a Path B request now, so a request filed before the
        // competition was published is built directly.
        const [planted] = await tx
          .insert(schema.institutionVerificationSubmissions)
          .values({
            institutionId: owner.institutionId,
            submittedByUserId: owner.ownerId,
            targetInstitutionType: "company",
            requestedPath: "instagram",
            instagramUrl: "https://www.instagram.com/acme.org/",
          })
          .returning({ id: schema.institutionVerificationSubmissions.id });
        const refused = await refusalOf(approve(tx, staffId, planted!.id));
        expect(refused).toBeInstanceOf(SubmissionError);
        expect(refused).toMatchObject({
          code: "institution_tick_live_paid_competition",
          status: 409,
        });
        expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe(
          "pending_verification",
        );
        const rows = await submissionRowsOf(tx, owner.institutionId);
        expect(rows).toHaveLength(rowsBefore + 1);
        expect(rows.find((row) => row.id === planted!.id)?.status).toBe("pending_review");

        await reviewVerificationSubmission(planted!.id, "rejected", null, staffId, tx);
        await tickByDocuments(tx, owner, staffId);
        const restored = await readWorkspace(tx, owner.institutionId);
        expect(restored.verificationStatus).toBe("verified");
        expect(restored.tickPath).toBe("documents");
      });
    });

    it("Path A refuses a workspace staff denied", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await verifyInstitution({
          institutionId: owner.institutionId,
          targetStatus: "rejected",
          reason: "Ditolak",
          actorUserId: staffId,
          db: tx,
        });
        const before = await snapshotOf(tx, owner.institutionId);

        const answer = await pressPathA(tx, owner.ownerId, owner.slug);

        expectRefusal(answer, 409, "institution_tick_path_a_closed", "staff");
        expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe("rejected");
        expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      });
    });

    it("Path A refuses an owner whose other workspace is closed", async () => {
      await inRollback(async (tx) => {
        const owner = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await pressPathA(tx, owner.ownerId, owner.slug);
        await revoke(tx, staffId, owner.institutionId);
        const second = await createWorkspace(tx, owner.ownerId);
        await saveWebsite(tx, owner.ownerId, second.slug, "https://www.acme.example");
        const before = await snapshotOf(tx, second.institutionId);

        const answer = await pressPathA(tx, owner.ownerId, second.slug);

        expectRefusal(answer, 409, "institution_tick_path_a_closed", "staff");
        expect(answer.body.error?.details?.closedInstitutionId).toBe(owner.institutionId);
        expect(await snapshotOf(tx, second.institutionId)).toEqual(before);

        const secondOwner = await addMember(
          tx,
          { ...owner, ...second },
          "institution_owner",
          "students.acme.example",
        );
        const secondPress = await pressPathA(tx, secondOwner.userId, second.slug);

        expect(secondPress.status).toBe(200);
        expect((await readWorkspace(tx, second.institutionId)).verificationStatus).toBe("verified");
      });
    });

    it("a staff closure holds after Tinjau ulang", async () => {
      await inRollback(async (tx) => {
        const revoked = await buildTickOwner(tx);
        const staffId = await seedStaff(tx);
        await pressPathA(tx, revoked.ownerId, revoked.slug);
        await revoke(tx, staffId, revoked.institutionId);
        await verifyInstitution({
          institutionId: revoked.institutionId,
          targetStatus: "under_review",
          actorUserId: staffId,
          db: tx,
        });
        await expectClosedAfterReview(tx, revoked);

        const denied = await buildTickOwner(tx);
        await verifyInstitution({
          institutionId: denied.institutionId,
          targetStatus: "rejected",
          reason: "Ditolak",
          actorUserId: staffId,
          db: tx,
        });
        await verifyInstitution({
          institutionId: denied.institutionId,
          targetStatus: "under_review",
          actorUserId: staffId,
          db: tx,
        });
        await expectClosedAfterReview(tx, denied);

        const restored = await buildTickOwner(tx);
        await pressPathA(tx, restored.ownerId, restored.slug);
        await revoke(tx, staffId, restored.institutionId);
        await tickByDocuments(tx, restored, staffId);
        const websiteChange = await patchProfile(tx, restored.ownerId, restored.slug, {
          websiteUrl: "https://portal.acme.example",
          acknowledgeTickRemoval: true,
        });
        expect(websiteChange.status).toBe(200);
        expect((await auditRowsOf(tx, restored.institutionId)).at(-1)?.reason).toBe(
          "Situs web diubah.",
        );

        const again = await pressPathA(tx, restored.ownerId, restored.slug);

        expect(again.status).toBe(200);
        expect((await readWorkspace(tx, restored.institutionId)).verificationStatus).toBe(
          "verified",
        );
      });
    });
  },
);

const expectClosedAfterReview = async (tx: Database, owner: TickOwner): Promise<void> => {
  const before = await snapshotOf(tx, owner.institutionId);
  const submissionsBefore = await submissionRowsOf(tx, owner.institutionId);

  const pathA = await pressPathA(tx, owner.ownerId, owner.slug);
  const pathB = await submit(tx, owner.ownerId, owner.slug, INSTAGRAM_REQUEST);

  expectRefusal(pathA, 409, "institution_tick_path_a_closed", "staff");
  expectRefusal(pathB, 409, "institution_tick_closed_needs_documents", "staff");
  expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe("under_review");
  expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
  expect(await submissionRowsOf(tx, owner.institutionId)).toEqual(submissionsBefore);
};

// A paid competition published through the draft, fee and publish services, as the owner would.
const publishPaidCompetition = async (tx: Database, owner: TickOwner): Promise<string> => {
  const now = Date.now();
  await tx.insert(schema.institutionPaymentInstructions).values({
    institutionId: owner.institutionId,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });
  await tx.insert(schema.financeFeeRules).values({
    institutionId: owner.institutionId,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(now - 30 * DAY_MS),
  });
  const draft = await createCompetitionDraft(
    owner.ownerId,
    {
      institutionSlug: owner.slug,
      title: `Kompetisi ${freshPart()}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      slug: null,
      category: "hackathon",
      mode: "individual",
      registrationStartAt: new Date(now + 7 * DAY_MS),
      registrationEndAt: new Date(now + 14 * DAY_MS),
      participantConfirmationAt: new Date(now + 20 * DAY_MS),
      eventStartAt: new Date(now + 30 * DAY_MS),
      eventEndAt: new Date(now + 31 * DAY_MS),
      resultAnnouncementAt: new Date(now + 40 * DAY_MS),
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
  await setCompetitionFee(
    owner.ownerId,
    draft.id,
    { feeAmount: 150_000, feeCurrency: "IDR", feeDisclosureAcknowledged: true },
    tx,
    new Date(),
  );
  await transitionCompetitionStatus(owner.ownerId, draft.id, "published", tx);
  return draft.id;
};

const createPaymentForNewRegistration = async (
  tx: Database,
  owner: TickOwner,
  competitionId: string,
) => {
  const candidateId = await signUpParticipant(tx, `peserta.${freshPart()}@pemilik.local`);
  const [registration] = await tx
    .insert(schema.competitionRegistrations)
    .values({ competitionId, studentId: candidateId, registrationType: "individual" })
    .returning({ id: schema.competitionRegistrations.id });
  return createPayment(
    {
      payerUserId: candidateId,
      receivingInstitutionId: owner.institutionId,
      origin: "manual_transfer",
      subject: {
        type: "competition_registration",
        competitionRegistrationId: registration!.id,
      },
      grossAmount: 150_000,
      currency: "IDR",
      pricedAt: new Date(),
      dueAt: new Date(Date.now() + 3 * DAY_MS),
    },
    tx,
  );
};

// ── Committed rows: a lock the service under test must wait on ───────────────────────────────

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
  "Path A and a Path B approval wait for a committed row lock (committed rows)",
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

    const sweep = async (): Promise<void> => {
      if (createdInstitutionIds.length > 0) {
        await control.db
          .delete(schema.institutions)
          .where(inArray(schema.institutions.id, createdInstitutionIds));
      }
      if (createdUserIds.length > 0) {
        await control.db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
      }
    };

    const survivors = async (): Promise<{ users: number; institutions: number }> => {
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
      return { users: users.length, institutions: institutionRows.length };
    };

    // Everything below runs on the control connection and commits, so it is built from real
    // services and recorded for the sweep as it is made.
    const seedCommittedTickOwner = async (): Promise<TickOwner> => {
      const database = asDatabase(control);
      const owner = await buildTickOwner(database);
      createdUserIds.push(owner.ownerId);
      createdInstitutionIds.push(owner.institutionId);
      return owner;
    };

    const seedCommittedStaff = async (): Promise<string> => {
      const staffId = await seedStaff(asDatabase(control));
      createdUserIds.push(staffId);
      return staffId;
    };

    it("a website change between the read and the write makes Path A miss", async () => {
      try {
        const owner = await seedCommittedTickOwner();
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);

        const outcome = await holdTransactionWhile(
          holder,
          (tx) =>
            updateInstitutionProfileForOwnerBySlug(
              owner.ownerId,
              owner.slug,
              { websiteUrl: "https://other.example" },
              tx,
            ),
          async () => {
            const running = settle(
              tickByOrganizationDomain(owner.ownerId, owner.slug, asDatabase(racer)),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "Path A");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({ code: "institution_tick_domain_mismatch", status: 422 });
        const row = await readWorkspace(asDatabase(control), owner.institutionId);
        expect(row.verificationStatus).toBe("pending_verification");
        expect(row.tickPath).toBeNull();
        expect(await auditRowsOf(asDatabase(control), owner.institutionId)).toEqual([]);
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0 });
      }
    }, 60_000);

    it("Path A and Path B stay closed after a staff revocation, even for a Path B approval that waited on it", async () => {
      try {
        const owner = await seedCommittedTickOwner();
        const staffId = await seedCommittedStaff();
        const database = asDatabase(control);
        await tickByOrganizationDomain(owner.ownerId, owner.slug, database);
        const request = await createInstagramTickRequest(
          owner.slug,
          "https://www.instagram.com/acme.org/",
          owner.ownerId,
          database,
        );
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);

        const outcome = await holdTransactionWhile(
          holder,
          (tx) =>
            verifyInstitution({
              institutionId: owner.institutionId,
              targetStatus: "rejected",
              reason: "Pelanggaran",
              actorUserId: staffId,
              db: tx,
            }),
          async () => {
            const running = settle(
              reviewVerificationSubmission(
                request.submissionId,
                "approved",
                null,
                staffId,
                asDatabase(racer),
              ),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the approval");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(SubmissionError);
        expect(error).toMatchObject({
          code: "institution_tick_closed_needs_documents",
          status: 409,
        });
        const row = await readWorkspace(database, owner.institutionId);
        expect(row.verificationStatus).toBe("rejected");
        expect(row.tickPath).toBeNull();
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0 });
      }
    }, 60_000);
  },
);

const MATCHING_PAGE_STATE = {
  workspaceClosure: null,
  otherWorkspaceClosure: null,
  hasPublishedPaidCompetition: false,
  organizationEmailDomain: "students.acme.example",
  websiteHost: "acme.example",
  domainsMatch: true,
};

describe.skipIf(skipWithoutDatabase)("the owner tick page read (real database)", () => {
  it("the tick page reads a matching Email organisasi and website", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);

      const state = await readTickPageState(owner.ownerId, owner.institutionId, tx);

      expect(state).toEqual(MATCHING_PAGE_STATE);
    });
  });

  it("the tick page reads a missing or unusable Email organisasi, a missing website and a mismatch", async () => {
    await inRollback(async (tx) => {
      const noOrganizationEmail = await buildTickOwner(tx, { organizationDomain: null });
      expect(
        await readTickPageState(noOrganizationEmail.ownerId, noOrganizationEmail.institutionId, tx),
      ).toEqual({ ...MATCHING_PAGE_STATE, organizationEmailDomain: null, domainsMatch: false });

      const noWebsite = await buildTickOwner(tx, { website: null });
      expect(await readTickPageState(noWebsite.ownerId, noWebsite.institutionId, tx)).toEqual({
        ...MATCHING_PAGE_STATE,
        websiteHost: null,
        domainsMatch: false,
      });

      const otherWebsite = await buildTickOwner(tx, { website: "https://www.other.example" });
      expect(await readTickPageState(otherWebsite.ownerId, otherWebsite.institutionId, tx)).toEqual(
        {
          ...MATCHING_PAGE_STATE,
          websiteHost: "other.example",
          domainsMatch: false,
        },
      );

      const signedInElsewhere = await buildTickOwner(tx);
      await signUpParticipant(tx, signedInElsewhere.organizationEmail!);
      expect(
        await readTickPageState(signedInElsewhere.ownerId, signedInElsewhere.institutionId, tx),
      ).toEqual({ ...MATCHING_PAGE_STATE, organizationEmailDomain: null, domainsMatch: false });

      const owner = await buildTickOwner(tx);
      const secondOwner = await addMember(tx, owner, "institution_owner", null);
      expect(await readTickPageState(secondOwner.userId, owner.institutionId, tx)).toEqual({
        ...MATCHING_PAGE_STATE,
        organizationEmailDomain: null,
        domainsMatch: false,
      });
    });
  });

  it("the tick page reads a staff closure on the workspace and on another workspace of the owner", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);
      const staffId = await seedStaff(tx);
      await pressPathA(tx, owner.ownerId, owner.slug);
      await revoke(tx, staffId, owner.institutionId);
      const second = await createWorkspace(tx, owner.ownerId);

      const revokedState = await readTickPageState(owner.ownerId, owner.institutionId, tx);
      const secondState = await readTickPageState(owner.ownerId, second.institutionId, tx);

      expect(revokedState.workspaceClosure).toBe("staff");
      expect(revokedState.otherWorkspaceClosure).toBeNull();
      expect(secondState.workspaceClosure).toBeNull();
      expect(secondState.otherWorkspaceClosure).toBe("staff");
    });
  });

  it("the tick page reads an automatic closure after a rename during a name proof", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);
      await pressPathA(tx, owner.ownerId, owner.slug);
      await startNameProof(tx, owner.institutionId);
      const rename = await patchSettings(tx, owner.ownerId, owner.slug, {
        displayName: `Nama Baru ${freshPart()}`,
        acknowledgeTickRemoval: true,
      });
      expect(rename.status).toBe(200);

      const state = await readTickPageState(owner.ownerId, owner.institutionId, tx);

      expect(state.workspaceClosure).toBe("automatic");
      expect(state.otherWorkspaceClosure).toBeNull();
    });
  });

  it("the tick page reads a published paid competition", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);
      const staffId = await seedStaff(tx);
      await tickByDocuments(tx, owner, staffId);
      await publishPaidCompetition(tx, owner);
      const rename = await patchSettings(tx, owner.ownerId, owner.slug, {
        displayName: `Nama Baru ${freshPart()}`,
        acknowledgeTickRemoval: true,
      });
      expect(rename.status).toBe(200);

      const state = await readTickPageState(owner.ownerId, owner.institutionId, tx);

      expect(state.hasPublishedPaidCompetition).toBe(true);
    });
  });

  it("the verification summary carries the tick path and the name columns", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);
      await pressPathA(tx, owner.ownerId, owner.slug);
      await startNameProof(tx, owner.institutionId);

      const summary = await loadInstitutionVerificationSummaryBySlug(owner.slug, tx);

      const row = await readWorkspace(tx, owner.institutionId);
      expect(summary?.tickPath).toBe("domain");
      expect(summary?.nameCheckedAt).toBeNull();
      expect(row.nameProofDueAt).not.toBeNull();
      expect(summary?.nameProofDueAt).toEqual(row.nameProofDueAt);
      expect(summary?.slug).toBe(owner.slug);
      const typedInCapitals = await loadInstitutionVerificationSummaryBySlug(
        owner.slug.toUpperCase(),
        tx,
      );
      expect(typedInCapitals?.slug).toBe(owner.slug);
    });
  });
});
