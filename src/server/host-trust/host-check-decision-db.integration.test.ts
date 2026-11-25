// @vitest-environment node

// The staff decision on a host check, the staff queue and the staff raise, against real rows in a
// rolled-back transaction. Hosts come through the real sign-up and host step services, drafts
// through the real competition services, host checks through the real publish route, decisions
// through the real decision route and raises through the real tier route. A row is planted directly
// only where this file does not drive its writer, and each such helper says so.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  enqueueApproved: vi.fn(async (_input: unknown) => ({})),
  enqueueRejected: vi.fn(async (_input: unknown) => ({})),
  sendApprovedEmail: vi.fn(async (_options: unknown) => undefined),
  sendRejectedEmail: vi.fn(async (_options: unknown) => undefined),
  sweepForAccount: vi.fn(async () => undefined),
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
  sendOrganizationEmailCode: async () => undefined,
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
    enqueueCompetitionCancelled: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: mocks.enqueueApproved,
    enqueueRecruiterVerificationRejected: mocks.enqueueRejected,
    enqueueHostTrustRemoved: vi.fn(async () => ({})),
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => routeState.transaction ?? actual.getDb() };
});

vi.mock("@/server/notifications/notification-email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications/notification-email")>();
  return {
    ...actual,
    sendRecruiterVerificationApprovedEmail: mocks.sendApprovedEmail,
    sendRecruiterVerificationRejectedEmail: mocks.sendRejectedEmail,
  };
});

vi.mock(
  "@/server/recruiter-verification/recruiter-verification-service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/recruiter-verification/recruiter-verification-service")
      >();
    return { ...actual, sweepOrphanedObjectsForAccount: mocks.sweepForAccount };
  },
);

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) throw new Error("the publish route ran with no session staged");
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
  requireSessionRole: async () => {
    if (!routeState.actorUserId) throw new Error("the staff route ran with no session staged");
    return {
      user: { id: routeState.actorUserId, role: "platform_ops" },
    } as unknown as AuthenticatedSession;
  },
}));

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import { createPersonalInstitutionForUser } from "@/server/institution-workspace/institution-service";
import { changeMemberRole, removeMember } from "@/server/institution-members/member-service";
import {
  createCompetitionDraft,
  softDeleteCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { resolveCompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
import { listHostChecks } from "./host-check-decision-service";
import { readHostStatusForAccount } from "./host-check-service";
import { removeHostTrust } from "./host-trust-removal-service";
import { suspendInstitution } from "@/server/moderation/moderation-service";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { POST as decideRoute } from "@/app/api/platform-ops/host-checks/[checkId]/route";
import { PATCH as raiseRoute } from "@/app/api/platform-ops/accounts/[accountId]/recruiter-tier/route";
import {
  processRecruiterVerificationApprovedJob,
  type RecruiterVerificationApprovedJob,
} from "@/server/async/jobs/recruiter-verification-approved";
import {
  processRecruiterVerificationRejectedJob,
  type RecruiterVerificationRejectedJob,
} from "@/server/async/jobs/recruiter-verification-rejected";
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
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
  mocks.enqueueApproved.mockClear();
  mocks.enqueueRejected.mockClear();
  mocks.sendApprovedEmail.mockClear();
  mocks.sendRejectedEmail.mockClear();
});

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
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

const signUpHost = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await markRoleAsVerified(userId, "recruiter", null, tx);
  return userId;
};

type Workspace = { institutionId: string; slug: string };

const ownWorkspace = async (tx: Database, ownerId: string): Promise<Workspace> => {
  const workspace = await createPersonalInstitutionForUser(ownerId, tx);
  return { institutionId: workspace.institutionId, slug: workspace.slug };
};

const DAY = 24 * 60 * 60 * 1000;

// A checklist-valid timeline whose registration end is still ahead.
const validTimeline = () => {
  const now = Date.now();
  return {
    registrationStartAt: new Date(now + 7 * DAY),
    registrationEndAt: new Date(now + 14 * DAY),
    participantConfirmationAt: new Date(now + 20 * DAY),
    eventStartAt: new Date(now + 30 * DAY),
    eventEndAt: new Date(now + 31 * DAY),
    resultAnnouncementAt: new Date(now + 40 * DAY),
  };
};

const createPublishableDraft = async (
  tx: Database,
  authorId: string,
  institutionSlug: string,
  title: string,
): Promise<string> => {
  const draft = await createCompetitionDraft(
    authorId,
    {
      institutionSlug,
      title,
      description: "Deskripsi kompetisi untuk pengujian.",
      slug: null,
      category: "hackathon",
      mode: "individual",
      ...validTimeline(),
    },
    tx,
  );
  await updateCompetitionDraft(authorId, draft.id, { location: "online" }, tx);
  await setCompetitionEligibilityForEditor(authorId, draft.id, { audience: ["umum"] }, tx);
  await setCompetitionOrganizerContactForEditor(
    authorId,
    draft.id,
    { kind: "whatsapp", value: "081298765432" },
    tx,
  );
  return draft.id;
};

// Planted directly: a stand-in for a staff trust removal, which this file does not drive. It takes
// the transaction-scoped opt-in that a removal needs to lower a trusted tier.
const plantTrustRemoval = async (tx: Database, userId: string): Promise<void> => {
  await tx.execute(sql`select set_config('lombakita.trust_removal', txid_current()::text, true)`);
  await tx
    .update(schema.users)
    .set({ recruiterVerificationTier: "minimal", hostTrustRemovedAt: new Date() })
    .where(eq(schema.users.id, userId));
};

// Planted directly: every writer that clears a removal also trusts the host, so none leaves an open check behind.
const plantTrustRemovalCleared = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ hostTrustRemovedAt: null })
    .where(eq(schema.users.id, userId));
};

// Planted directly: an open host request without a draft, as the old request flow wrote it.
const plantOpenRequestWithoutDraft = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .insert(schema.recruiterVerificationSubmissions)
    .values({
      userId,
      fullName: "Rina Pratama",
      mobileNumber: "0812345678",
      status: "pending_review",
    })
    .returning({ id: schema.recruiterVerificationSubmissions.id });
  if (!row) throw new Error("No host request row");
  return row.id;
};

const competitionStatusOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({ status: schema.competitions.status })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.status;
};

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

type PressBody = {
  competition?: { id: string; status: string };
  hostCheck?: { id: string; status: string; submittedAt: string };
  error?: { code: string; details?: { pendingCompetitionTitle?: string } };
};

const pressPublishThroughRoute = async (
  tx: Database,
  actorUserId: string,
  institutionSlug: string,
  competitionId: string,
): Promise<{ status: number; body: PressBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const request = new Request(
    `http://localhost/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/publish`,
    { method: "POST", headers: { [SESSION_USER_HEADER]: actorUserId } },
  );
  const response = await publishRoute(request, {
    params: Promise.resolve({ institutionSlug, competitionId }),
  });
  const body = (await response.json()) as PressBody;
  return { status: response.status, body };
};

const pressOn = (tx: Database, actorUserId: string, workspace: Workspace, competitionId: string) =>
  pressPublishThroughRoute(tx, actorUserId, workspace.slug, competitionId);

const FIRST_TITLE = "Lomba Esai Nasional";
const SECOND_TITLE = "Lomba Poster Digital";

// Planted directly: a stand-in for the operator promotion, which this file does not drive.
const plantOperator = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, userId));
  return userId;
};

// Planted directly: another account's open host check, which only that account's press writes.
const plantOpenCheck = async (
  tx: Database,
  userId: string,
  competitionId: string,
): Promise<string> => {
  const [row] = await tx
    .insert(schema.recruiterVerificationSubmissions)
    .values({
      userId,
      competitionId,
      fullName: "Dina Lestari",
      mobileNumber: "0819876543",
      status: "pending_review",
    })
    .returning({ id: schema.recruiterVerificationSubmissions.id });
  if (!row) throw new Error("No host check row");
  return row.id;
};

// Planted directly: an account whose email is unconfirmed, which no signed-in path can hold.
const plantEmailUnconfirmed = async (tx: Database, userId: string): Promise<void> => {
  await tx.update(schema.users).set({ emailVerified: null }).where(eq(schema.users.id, userId));
};

// Planted directly: a stand-in for a staff suspension of the workspace, which this file does not drive.
const plantInstitutionSuspended = async (tx: Database, institutionId: string): Promise<void> => {
  await tx
    .update(schema.institutions)
    .set({ suspendedAt: new Date() })
    .where(eq(schema.institutions.id, institutionId));
};

// Planted directly: a stand-in for a staff suspension of the account, which this file does not drive.
const plantAccountSuspended = async (tx: Database, userId: string): Promise<void> => {
  await tx.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, userId));
};

// Planted directly: a stand-in for a trust the account gained after its press, such as a confirmed Email organisasi.
const plantTrusted = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ recruiterVerificationTier: "elevated" })
    .where(eq(schema.users.id, userId));
};

// Planted directly: audit rows that an earlier and a later transaction write. Every row one rolled
// back test writes carries the same now(), so only planted times can order the removal read.
const plantAuditRow = async (
  tx: Database,
  actorUserId: string,
  targetUserId: string,
  eventType: string,
  reason: string,
  createdAt: Date,
): Promise<void> => {
  await tx
    .insert(schema.platformOpsAuditLogs)
    .values({ actorUserId, targetUserId, eventType, reason, createdAt });
};

// Planted directly: a host check sent days ago, which no path back-dates.
const plantSubmittedDaysAgo = async (
  tx: Database,
  checkId: string,
  days: number,
): Promise<void> => {
  await tx
    .update(schema.recruiterVerificationSubmissions)
    .set({ submittedAt: new Date(Date.now() - days * DAY) })
    .where(eq(schema.recruiterVerificationSubmissions.id, checkId));
};

const hostCheckRowOf = async (tx: Database, id: string) => {
  const [row] = await tx
    .select({
      status: schema.recruiterVerificationSubmissions.status,
      rejectionReason: schema.recruiterVerificationSubmissions.rejectionReason,
      guidelineItem: schema.recruiterVerificationSubmissions.guidelineItem,
      resubmissionAllowed: schema.recruiterVerificationSubmissions.resubmissionAllowed,
      reviewedAt: schema.recruiterVerificationSubmissions.reviewedAt,
      reviewerUserId: schema.recruiterVerificationSubmissions.reviewerUserId,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.id, id));
  if (!row) throw new Error("No host check row");
  return row;
};

const trustRemovedAtOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ hostTrustRemovedAt: schema.users.hostTrustRemovedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.hostTrustRemovedAt;
};

const competitionSlugOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({ slug: schema.competitions.slug })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.slug;
};

const organizerContactValueOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({ value: schema.competitions.organizerContactValue })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.value;
};

const institutionNameOf = async (tx: Database, institutionId: string) => {
  const [row] = await tx
    .select({ displayName: schema.institutions.displayName })
    .from(schema.institutions)
    .where(eq(schema.institutions.id, institutionId));
  if (!row) throw new Error("No institution row");
  return row.displayName;
};

const auditRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      actorUserId: schema.platformOpsAuditLogs.actorUserId,
      eventType: schema.platformOpsAuditLogs.eventType,
      reason: schema.platformOpsAuditLogs.reason,
      metadata: schema.platformOpsAuditLogs.metadata,
    })
    .from(schema.platformOpsAuditLogs)
    .where(eq(schema.platformOpsAuditLogs.targetUserId, userId));

const inboxOf = (tx: Database, userId: string) =>
  tx
    .select({ title: schema.notifications.title, body: schema.notifications.body })
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));

const createIncompleteDraft = async (
  tx: Database,
  authorId: string,
  institutionSlug: string,
  title: string,
): Promise<string> => {
  const draft = await createCompetitionDraft(
    authorId,
    {
      institutionSlug,
      title,
      description: "Deskripsi kompetisi untuk pengujian.",
      slug: null,
    },
    tx,
  );
  return draft.id;
};

// Planted directly: a stand-in for an invitation the person took up, which this file does not drive.
const plantMembership = async (
  tx: Database,
  institutionId: string,
  userId: string,
  membershipRole: "institution_staff" | "institution_member",
): Promise<void> => {
  await tx.insert(schema.institutionMemberships).values({
    institutionId,
    userId,
    membershipRole,
    status: "active",
  });
};

const membershipIdOf = async (
  tx: Database,
  institutionId: string,
  userId: string,
): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.institutionMemberships.id })
    .from(schema.institutionMemberships)
    .where(
      and(
        eq(schema.institutionMemberships.institutionId, institutionId),
        eq(schema.institutionMemberships.userId, userId),
      ),
    );
  if (!row) throw new Error("No membership row");
  return row.id;
};

// Planted directly: a stand-in for an account de-identification, which this file does not drive.
const plantAccountDeactivated = async (tx: Database, userId: string): Promise<void> => {
  await tx.update(schema.users).set({ status: "deactivated" }).where(eq(schema.users.id, userId));
};

const openCheckBy = async (
  tx: Database,
  host: string,
  title: string,
): Promise<{ workspace: Workspace; draft: string; checkId: string }> => {
  const workspace = await ownWorkspace(tx, host);
  const draft = await createPublishableDraft(tx, host, workspace.slug, title);
  const pressed = await pressOn(tx, host, workspace, draft);
  if (pressed.status !== 202 || pressed.body.hostCheck === undefined) {
    throw new Error("the press opened no host check");
  }
  return { workspace, draft, checkId: pressed.body.hostCheck.id };
};

type DecisionBody = {
  hostCheck?: { id: string; userId: string; status: string; published: boolean };
  error?: { code: string };
};

const decideThroughRoute = async (
  tx: Database,
  staffUserId: string,
  checkId: string,
  body: unknown,
): Promise<{ status: number; body: DecisionBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = staffUserId;
  const request = new Request(`http://localhost/api/platform-ops/host-checks/${checkId}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const response = await decideRoute(request, { params: Promise.resolve({ checkId }) });
  const parsed = (await response.json()) as DecisionBody;
  return { status: response.status, body: parsed };
};

const raiseThroughRoute = async (
  tx: Database,
  staffUserId: string,
  accountId: string,
): Promise<{ status: number; body: unknown }> => {
  routeState.transaction = tx;
  routeState.actorUserId = staffUserId;
  const request = new Request(
    `http://localhost/api/platform-ops/accounts/${accountId}/recruiter-tier`,
    {
      method: "PATCH",
      body: JSON.stringify({ tier: "elevated" }),
    },
  );
  const response = await raiseRoute(request, { params: Promise.resolve({ accountId }) });
  const parsed: unknown = await response.json();
  return { status: response.status, body: parsed };
};

const runApprovalJob = (payload: unknown) =>
  processRecruiterVerificationApprovedJob({
    id: "job_approval",
    data: payload,
  } as unknown as RecruiterVerificationApprovedJob);

const runTurnDownJob = (payload: unknown) =>
  processRecruiterVerificationRejectedJob({
    id: "job_turn_down",
    data: payload,
  } as unknown as RecruiterVerificationRejectedJob);

const UNTRUSTED_HOST_ADDRESS = "rina.free@gmail.com";
const SECOND_UNTRUSTED_HOST_ADDRESS = "sari.free@gmail.com";
const OPERATOR_ADDRESS = "ops.staf@acme.example";
const OTHER_ADDRESS = "dina@example.test";
const OWNER_ADDRESS = "budi.host@acme.example";
const NOTE = "Nomor kontak tidak aktif.";
const TURN_DOWN = { decision: "turn_down", guidelineItem: "kontak-nyata", note: NOTE };
const APPROVE = { decision: "approve" };
const KONTAK_TEXT = "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.";
const FALLBACK_BODY = "Akun Anda kini tepercaya. Kompetisi yang Anda terbitkan langsung tayang.";
const RAISE_FALLBACK_BODY = "Anda sekarang dapat menerbitkan kompetisi dari dasbor penyelenggara.";

describe.skipIf(skipWithoutDatabase)("the staff decision on a host check (rolled back)", () => {
  it("approves a host check the press opened, publishes its draft as the host and trusts the host", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { workspace, draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const ownerDraft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, SECOND_TITLE);
      const other = await signUpParticipant(tx, OTHER_ADDRESS);
      const otherCheck = await plantOpenCheck(tx, other, ownerDraft);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "approved", published: true },
      });
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await hostCheckRowOf(tx, checkId)).toEqual({
        status: "approved",
        rejectionReason: null,
        guidelineItem: null,
        resubmissionAllowed: true,
        reviewedAt: expect.any(Date),
        reviewerUserId: operator,
      });
      expect((await hostCheckRowOf(tx, otherCheck)).status).toBe("pending_review");
      expect(
        (await auditRowsOf(tx, host)).filter((row) => row.eventType === "host_check.approved"),
      ).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.approved",
          reason: null,
          metadata: { checkId, competitionId: draft },
        },
      ]);
      expect(
        (await auditRowsOf(tx, host)).filter(
          (row) => row.eventType === "host_check.approval_publish",
        ),
      ).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.approval_publish",
          reason: null,
          metadata: { checkId, competitionId: draft, published: true },
        },
      ]);
      expect(mocks.enqueueApproved).toHaveBeenCalledWith({
        userId: host,
        competitionId: draft,
        epoch: expect.any(Number),
      });

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        {
          title: "Kompetisi Anda lolos pemeriksaan",
          body: 'Akun Anda kini tepercaya dan "Lomba Esai Nasional" sudah tayang.',
        },
      ]);
      expect(mocks.sendApprovedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        title: "Kompetisi Anda lolos pemeriksaan",
        body: 'Akun Anda kini tepercaya dan "Lomba Esai Nasional" sudah tayang.',
        path: `/competitions/${workspace.slug}/${await competitionSlugOf(tx, draft)}`,
      });
    });
  });

  it("turns a host check down with a guideline item and a note, and leaves the draft and the tier", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, {
        decision: "turn_down",
        guidelineItem: "kontak-nyata",
        note: "  Nomor kontak tidak aktif.  ",
      });

      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "rejected", published: false },
      });
      expect(await hostCheckRowOf(tx, checkId)).toEqual({
        status: "rejected",
        rejectionReason: NOTE,
        guidelineItem: "kontak-nyata",
        resubmissionAllowed: false,
        reviewedAt: expect.any(Date),
        reviewerUserId: operator,
      });
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await auditRowsOf(tx, host)).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.turned_down",
          reason: NOTE,
          metadata: { checkId, competitionId: draft, guidelineItem: "kontak-nyata" },
        },
      ]);
      expect(mocks.enqueueRejected).toHaveBeenCalledWith({
        submissionId: checkId,
        userId: host,
        rejectionReason: NOTE,
        resubmissionAllowed: false,
        guidelineItem: "kontak-nyata",
        epoch: expect.any(Number),
      });
      expect(await resolveCompetitionPublishReadiness(host, draft, tx)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "turned_down", guidelineItem: "kontak-nyata", note: NOTE },
      });

      await runTurnDownJob(mocks.enqueueRejected.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        {
          title: "Kompetisi Anda belum dapat tayang",
          body: `Pedoman: ${KONTAK_TEXT} Catatan staf: ${NOTE} Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.`,
        },
      ]);
      expect(mocks.sendRejectedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        rejectionReason: NOTE,
        resubmissionAllowed: false,
        hostCheckTurnDown: {
          title: "Kompetisi Anda belum dapat tayang",
          body: `Pedoman: ${KONTAK_TEXT} Catatan staf: ${NOTE} Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.`,
        },
      });
    });
  });

  it("refuses a turn-down without a known guideline item or a note and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const refusedBodies = [
        { body: { decision: "turn_down", note: NOTE }, code: "host_check_guideline_required" },
        {
          body: { decision: "turn_down", guidelineItem: "bukan-pedoman", note: NOTE },
          code: "host_check_guideline_unknown",
        },
        {
          body: { decision: "turn_down", guidelineItem: "kontak-nyata", note: "   " },
          code: "host_check_note_required",
        },
        {
          body: { decision: "turn_down", guidelineItem: "kontak-nyata", note: "a".repeat(1001) },
          code: "host_check_note_required",
        },
      ];

      for (const { body, code } of refusedBodies) {
        const refused = await decideThroughRoute(tx, operator, checkId, body);
        expect(refused.status).toBe(400);
        expect(refused.body.error?.code).toBe(code);
      }

      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
      expect(await auditRowsOf(tx, host)).toEqual([]);
      expect(mocks.enqueueRejected).not.toHaveBeenCalled();
    });
  });

  it("refuses a decision by an account that is not platform_ops and by the host's own operator account, and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const other = await signUpParticipant(tx, OTHER_ADDRESS);

      const byParticipant = await decideThroughRoute(tx, other, checkId, APPROVE);

      expect(byParticipant.status).toBe(403);
      expect(byParticipant.body.error?.code).toBe("operator_actor_not_platform_ops");

      // Planted directly: a stand-in for the operator promotion of the host itself.
      await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, host));

      const bySelf = await decideThroughRoute(tx, host, checkId, APPROVE);

      expect(bySelf.status).toBe(403);
      expect(bySelf.body.error?.code).toBe("operator_actor_is_target");
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await auditRowsOf(tx, host)).toEqual([]);
      expect(mocks.enqueueApproved).not.toHaveBeenCalled();
    });
  });

  it("refuses a second decision on a host check that staff already closed, and keeps the first", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const first = await decideThroughRoute(tx, operator, checkId, APPROVE);
      expect(first.status).toBe(200);

      const second = await decideThroughRoute(tx, operator, checkId, TURN_DOWN);

      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("host_check_already_decided");
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("approved");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect((await auditRowsOf(tx, host)).map((row) => row.eventType).sort()).toEqual([
        "host_check.approval_publish",
        "host_check.approved",
      ]);
      expect(mocks.enqueueRejected).not.toHaveBeenCalled();
    });
  });

  it("answers not found for an open host request without a draft and for an unknown id", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const legacyId = await plantOpenRequestWithoutDraft(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const byLegacy = await decideThroughRoute(tx, operator, legacyId, APPROVE);

      expect(byLegacy.status).toBe(404);
      expect(byLegacy.body.error?.code).toBe("host_check_not_found");
      expect((await hostCheckRowOf(tx, legacyId)).status).toBe("pending_review");
      expect(await tierOf(tx, host)).toBe("minimal");

      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const ownerDraft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, SECOND_TITLE);
      const other = await signUpParticipant(tx, OTHER_ADDRESS);
      await plantOpenCheck(tx, other, ownerDraft);

      const byUnknown = await decideThroughRoute(tx, operator, randomUUID(), APPROVE);

      expect(byUnknown.status).toBe(404);

      const byMalformed = await decideThroughRoute(tx, operator, "not-a-uuid", APPROVE);

      expect(byMalformed.status).toBe(404);
      expect(byMalformed.body.error?.code).toBe("host_check_not_found");
    });
  });

  it("answers not found for the host check of an account whose email is unconfirmed, and leaves it out of the queue", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantEmailUnconfirmed(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(404);
      expect(answered.body.error?.code).toBe("host_check_not_found");
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
      expect((await listHostChecks(tx)).filter((entry) => entry.host.userId === host)).toEqual([]);
    });
  });

  it("keeps the account trusted and the draft a draft when the approval's publish is refused, and the notice says to publish", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { workspace, draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantInstitutionSuspended(tx, workspace.institutionId);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "approved", published: false },
      });
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(
        (await auditRowsOf(tx, host)).filter(
          (row) => row.eventType === "host_check.approval_publish",
        ),
      ).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.approval_publish",
          reason: null,
          metadata: { checkId, competitionId: draft, published: false },
        },
      ]);

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        {
          title: "Kompetisi Anda lolos pemeriksaan",
          body: 'Akun Anda kini tepercaya. Buka draf "Lomba Esai Nasional" lalu tekan Terbitkan.',
        },
      ]);
    });
  });

  it("publishes nothing for a host suspended while the check was open, and leaves the account trusted", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantAccountSuspended(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(200);
      expect(answered.body.hostCheck?.published).toBe(false);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await tierOf(tx, host)).toBe("elevated");
    });
  });

  it("clears a trust removal and closes the open host check as approved when staff raise the host, without publishing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantTrustRemoval(tx, host);
      const { workspace, draft, checkId: firstCheck } = await openCheckBy(tx, host, FIRST_TITLE);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const turnedDown = await decideThroughRoute(tx, operator, firstCheck, TURN_DOWN);
      expect(turnedDown.status).toBe(200);
      const pressedAgain = await pressOn(tx, host, workspace, draft);
      expect(pressedAgain.status).toBe(202);
      const secondCheck = pressedAgain.body.hostCheck!.id;
      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const ownerDraft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, SECOND_TITLE);
      const other = await signUpParticipant(tx, OTHER_ADDRESS);
      const otherCheck = await plantOpenCheck(tx, other, ownerDraft);

      const raised = await raiseThroughRoute(tx, operator, host);

      expect(raised.status).toBe(200);
      expect(raised.body).toEqual({ accountId: host, tier: "elevated", changed: true });
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, host)).toBeNull();
      expect(await hostCheckRowOf(tx, secondCheck)).toEqual({
        status: "approved",
        rejectionReason: null,
        guidelineItem: null,
        resubmissionAllowed: true,
        reviewedAt: expect.any(Date),
        reviewerUserId: operator,
      });
      expect((await hostCheckRowOf(tx, firstCheck)).status).toBe("rejected");
      expect((await hostCheckRowOf(tx, otherCheck)).status).toBe("pending_review");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(
        (await auditRowsOf(tx, host)).filter((row) => row.eventType === "recruiter_tier.elevated"),
      ).toEqual([
        {
          actorUserId: operator,
          eventType: "recruiter_tier.elevated",
          reason: null,
          metadata: {
            from: "minimal",
            to: "elevated",
            clearedTrustRemoval: true,
            closedHostCheckId: secondCheck,
          },
        },
      ]);
      expect(mocks.enqueueApproved).toHaveBeenCalledWith({
        userId: host,
        epoch: expect.any(Number),
      });
    });
  });

  it("leaves the open host check of a host that is already trusted open when staff raise it", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantTrusted(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const raised = await raiseThroughRoute(tx, operator, host);

      expect(raised.status).toBe(200);
      expect(raised.body).toEqual({ accountId: host, tier: "elevated", changed: false });
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
    });
  });

  it("leaves an open host request without a draft to the next press when staff raise the account", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const legacyId = await plantOpenRequestWithoutDraft(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const raised = await raiseThroughRoute(tx, operator, host);

      expect(raised.status).toBe(200);
      expect((await hostCheckRowOf(tx, legacyId)).status).toBe("pending_review");
      expect(await tierOf(tx, host)).toBe("elevated");
    });
  });

  it("clears a trust removal when staff approve the host check of a removed host", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantTrustRemoval(tx, host);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.body.hostCheck?.published).toBe(true);
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, host)).toBeNull();
    });
  });

  it("lists open host checks on live drafts oldest first, with the host, the draft and only the staff turn-downs before", async () => {
    await inRollback(async (tx) => {
      const hostA = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspaceA = await ownWorkspace(tx, hostA);
      const goneDraft = await createPublishableDraft(
        tx,
        hostA,
        workspaceA.slug,
        "Lomba Fotografi Alam",
      );
      const goneSent = await pressOn(tx, hostA, workspaceA, goneDraft);
      expect(goneSent.status).toBe(202);
      await softDeleteCompetitionDraft(hostA, goneDraft, tx);
      const draftA = await createPublishableDraft(tx, hostA, workspaceA.slug, FIRST_TITLE);
      const firstSent = await pressOn(tx, hostA, workspaceA, draftA);
      expect(firstSent.status).toBe(202);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const turnedDown = await decideThroughRoute(
        tx,
        operator,
        firstSent.body.hostCheck!.id,
        TURN_DOWN,
      );
      expect(turnedDown.status).toBe(200);
      const secondSent = await pressOn(tx, hostA, workspaceA, draftA);
      expect(secondSent.status).toBe(202);
      const checkA = secondSent.body.hostCheck!.id;
      await plantSubmittedDaysAgo(tx, checkA, 8);
      const hostB = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const { draft: draftB, checkId: checkB } = await openCheckBy(tx, hostB, SECOND_TITLE);
      const legacy = await signUpParticipant(tx, OTHER_ADDRESS);
      await plantOpenRequestWithoutDraft(tx, legacy);

      const mine = (await listHostChecks(tx)).filter((entry) =>
        [hostA, hostB, legacy].includes(entry.host.userId),
      );

      expect(mine.map((entry) => entry.id)).toEqual([checkA, checkB]);
      expect(mine[0]).toEqual({
        id: checkA,
        submittedAt: expect.any(Date),
        overdue: true,
        host: {
          userId: hostA,
          fullName: "Rina Pratama",
          mobileNumber: "0812345678",
          email: UNTRUSTED_HOST_ADDRESS,
          trustRemovedAt: null,
          trustRemovalReason: null,
        },
        draft: {
          competitionId: draftA,
          title: FIRST_TITLE,
          description: "Deskripsi kompetisi untuk pengujian.",
          category: "hackathon",
          mode: "individual",
          location: "online",
          registrationStartAt: expect.any(Date),
          registrationEndAt: expect.any(Date),
          eventStartAt: expect.any(Date),
          eventEndAt: expect.any(Date),
          resultAnnouncementAt: expect.any(Date),
          feeAmount: null,
          feeCurrency: null,
          organizerContactKind: "whatsapp",
          organizerContactValue: await organizerContactValueOf(tx, draftA),
          institutionName: await institutionNameOf(tx, workspaceA.institutionId),
        },
        earlierTurnDowns: [
          { reviewedAt: expect.any(Date), guidelineItem: "kontak-nyata", note: NOTE },
        ],
      });
      expect(mine[1]?.overdue).toBe(false);
      expect(mine[1]?.earlierTurnDowns).toEqual([]);

      await softDeleteCompetitionDraft(hostB, draftB, tx);

      expect(
        (await listHostChecks(tx))
          .filter((entry) => [hostA, hostB].includes(entry.host.userId))
          .map((entry) => entry.id),
      ).toEqual([checkA]);
    });
  });

  it("names no draft in the approval notice of a host whose staff membership ended while the check was open", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await ownWorkspace(tx, host);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const pressed = await pressOn(tx, host, ownerWorkspace, draft);
      expect(pressed.status).toBe(202);
      const checkId = pressed.body.hostCheck!.id;
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await removeMember(owner, ownerWorkspace.slug, membershipId, tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "approved", published: false },
      });
      expect(await competitionStatusOf(tx, draft)).toBe("draft");

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        { title: "Kompetisi Anda lolos pemeriksaan", body: FALLBACK_BODY },
      ]);
      expect(mocks.sendApprovedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        title: "Kompetisi Anda lolos pemeriksaan",
        body: FALLBACK_BODY,
        path: "/recruiter-dashboard",
      });
    });
  });

  it("names no draft in the approval notice of a host moved down to institution_member while the check was open", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const pressed = await pressOn(tx, host, ownerWorkspace, draft);
      expect(pressed.status).toBe(202);
      const checkId = pressed.body.hostCheck!.id;
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await changeMemberRole(owner, ownerWorkspace.slug, membershipId, "institution_member", tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "approved", published: false },
      });
      expect(await competitionStatusOf(tx, draft)).toBe("draft");

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        { title: "Kompetisi Anda lolos pemeriksaan", body: FALLBACK_BODY },
      ]);
      expect(mocks.sendApprovedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        title: "Kompetisi Anda lolos pemeriksaan",
        body: FALLBACK_BODY,
        path: "/recruiter-dashboard",
      });
    });
  });

  it("names no draft in the raise notice of a host whose staff membership ended", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await ownWorkspace(tx, host);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      await createIncompleteDraft(tx, host, ownerWorkspace.slug, FIRST_TITLE);
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await removeMember(owner, ownerWorkspace.slug, membershipId, tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const raised = await raiseThroughRoute(tx, operator, host);

      expect(raised.status).toBe(200);

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        { title: "Akun Anda kini penyelenggara tepercaya", body: RAISE_FALLBACK_BODY },
      ]);
      expect(mocks.sendApprovedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        title: "Akun Anda kini penyelenggara tepercaya",
        body: RAISE_FALLBACK_BODY,
        path: "/recruiter-dashboard",
      });
    });
  });

  it("names no draft in the raise notice of a host moved down to institution_member", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      await createIncompleteDraft(tx, host, ownerWorkspace.slug, FIRST_TITLE);
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await changeMemberRole(owner, ownerWorkspace.slug, membershipId, "institution_member", tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const raised = await raiseThroughRoute(tx, operator, host);

      expect(raised.status).toBe(200);

      await runApprovalJob(mocks.enqueueApproved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([
        { title: "Akun Anda kini penyelenggara tepercaya", body: RAISE_FALLBACK_BODY },
      ]);
      expect(mocks.sendApprovedEmail).toHaveBeenCalledWith({
        toEmail: UNTRUSTED_HOST_ADDRESS,
        recipientId: host,
        title: "Akun Anda kini penyelenggara tepercaya",
        body: RAISE_FALLBACK_BODY,
        path: "/recruiter-dashboard",
      });
    });
  });

  it("closes a host check whose draft was deleted when staff approve it, with no trust, no publish and no notice", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await softDeleteCompetitionDraft(host, draft, tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "rejected", published: false },
      });
      expect(await hostCheckRowOf(tx, checkId)).toEqual({
        status: "rejected",
        rejectionReason: "Ditutup karena draf tidak lagi tersedia.",
        guidelineItem: null,
        resubmissionAllowed: false,
        reviewedAt: expect.any(Date),
        reviewerUserId: operator,
      });
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await auditRowsOf(tx, host)).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.closed_without_draft",
          reason: null,
          metadata: { checkId, competitionId: draft },
        },
      ]);
      expect(mocks.enqueueApproved).not.toHaveBeenCalled();
      expect(mocks.enqueueRejected).not.toHaveBeenCalled();
    });
  });

  it("closes a host check whose draft was deleted when staff turn it down, with no turn-down notice and no earlier turn-down", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { workspace, draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await softDeleteCompetitionDraft(host, draft, tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, TURN_DOWN);

      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({
        hostCheck: { id: checkId, userId: host, status: "rejected", published: false },
      });
      expect(await hostCheckRowOf(tx, checkId)).toEqual({
        status: "rejected",
        rejectionReason: "Ditutup karena draf tidak lagi tersedia.",
        guidelineItem: null,
        resubmissionAllowed: false,
        reviewedAt: expect.any(Date),
        reviewerUserId: operator,
      });
      expect(await auditRowsOf(tx, host)).toEqual([
        {
          actorUserId: operator,
          eventType: "host_check.closed_without_draft",
          reason: null,
          metadata: { checkId, competitionId: draft },
        },
      ]);
      expect(mocks.enqueueRejected).not.toHaveBeenCalled();
      expect(mocks.enqueueApproved).not.toHaveBeenCalled();

      const nextDraft = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
      const nextSent = await pressOn(tx, host, workspace, nextDraft);
      expect(nextSent.status).toBe(202);
      const queued = (await listHostChecks(tx)).filter((entry) => entry.host.userId === host);
      expect(queued.map((entry) => entry.id)).toEqual([nextSent.body.hostCheck!.id]);
      expect(queued[0]?.earlierTurnDowns).toEqual([]);
    });
  });

  it("gives the queue the reason of a host's newest trust removal, and no reason for a host whose trust staff never removed", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const raised = await raiseThroughRoute(tx, operator, host);
      expect(raised.status).toBe(200);
      await plantAuditRow(
        tx,
        operator,
        host,
        "host_trust.removed",
        "Kontak palsu.",
        new Date(Date.now() - DAY),
      );
      await removeHostTrust(operator, host, "Hadiah tidak sesuai.", tx);
      await plantAuditRow(
        tx,
        operator,
        host,
        "user.suspended",
        "Penangguhan sementara.",
        new Date(Date.now() + DAY),
      );
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      const other = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const { checkId: otherCheckId } = await openCheckBy(tx, other, SECOND_TITLE);

      const mine = (await listHostChecks(tx)).filter((entry) =>
        [host, other].includes(entry.host.userId),
      );

      expect(
        Object.fromEntries(mine.map((entry) => [entry.id, entry.host.trustRemovalReason])),
      ).toEqual({ [checkId]: "Hadiah tidak sesuai.", [otherCheckId]: null });
      expect(mine.find((entry) => entry.id === checkId)?.host.trustRemovedAt).toEqual(
        expect.any(Date),
      );
    });
  });

  it("refuses a decision on the host check of a de-identified account and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const { draft, checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantAccountDeactivated(tx, host);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(409);
      expect(answered.body.error?.code).toBe("account_deactivated");
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await auditRowsOf(tx, host)).toEqual([]);
    });
  });

  it("refuses to approve the host check of an account without the host role and changes nothing", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const candidate = await signUpParticipant(tx, OTHER_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, candidate, "institution_staff");
      const pressed = await pressOn(tx, candidate, ownerWorkspace, draft);
      expect(pressed.status).toBe(202);
      const checkId = pressed.body.hostCheck!.id;
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const answered = await decideThroughRoute(tx, operator, checkId, APPROVE);

      expect(answered.status).toBe(422);
      expect(answered.body.error?.code).toBe("host_check_target_not_host");
      expect((await hostCheckRowOf(tx, checkId)).status).toBe("pending_review");
      expect(await tierOf(tx, candidate)).toBe("unverified");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await auditRowsOf(tx, candidate)).toEqual([]);
    });
  });

  it("reads the host status of the asking account only", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const other = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      await openCheckBy(tx, other, SECOND_TITLE);

      const ownerStatus = await readHostStatusForAccount(owner, tx);
      const hostStatus = await readHostStatusForAccount(host, tx);

      expect(ownerStatus).toEqual({ state: "trusted" });
      expect(hostStatus).toEqual({ state: "not_trusted" });
    });
  });

  it("reads a waiting host as pending with the title of the draft it sent", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await openCheckBy(tx, host, FIRST_TITLE);

      const status = await readHostStatusForAccount(host, tx);

      expect(status).toEqual({ state: "pending", competitionTitle: FIRST_TITLE });
    });
  });

  it("names no draft in the host status once the host left the workspace of the waiting draft", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await ownWorkspace(tx, host);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const pressed = await pressOn(tx, host, ownerWorkspace, draft);
      expect(pressed.status).toBe(202);
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await removeMember(owner, ownerWorkspace.slug, membershipId, tx);

      const status = await readHostStatusForAccount(host, tx);

      expect(status).toEqual({ state: "pending" });
    });
  });

  it("reads a removed host as removed, a removed host who waits as pending, and a raised host as trusted", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, OWNER_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeHostTrust(operator, host, "Hadiah tidak sesuai.", tx);

      expect(await readHostStatusForAccount(host, tx)).toEqual({ state: "trust_removed" });

      await openCheckBy(tx, host, FIRST_TITLE);

      expect(await readHostStatusForAccount(host, tx)).toEqual({
        state: "pending",
        competitionTitle: FIRST_TITLE,
      });

      const raised = await raiseThroughRoute(tx, operator, host);
      expect(raised.status).toBe(200);

      expect(await readHostStatusForAccount(host, tx)).toEqual({ state: "trusted" });
    });
  });

  it("gives the queue no removal reason once the host's removal no longer stands", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const raised = await raiseThroughRoute(tx, operator, host);
      expect(raised.status).toBe(200);
      await removeHostTrust(operator, host, "Hadiah tidak sesuai.", tx);
      const { checkId } = await openCheckBy(tx, host, FIRST_TITLE);
      await plantTrustRemovalCleared(tx, host);

      const entry = (await listHostChecks(tx)).find((queued) => queued.id === checkId);

      expect(entry?.host.trustRemovedAt).toBe(null);
      expect(entry?.host.trustRemovalReason).toBe(null);
    });
  });

  it("reads an untrusted staff member of a workspace with a trusted owner as not trusted in a trusted workspace, an institution_member of it as not trusted alone, and the staff member alone once the membership ends", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const member = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, member, "institution_member");

      const hostStatus = await readHostStatusForAccount(host, tx);
      const memberStatus = await readHostStatusForAccount(member, tx);

      expect(hostStatus).toEqual({ state: "not_trusted", runsTrustedWorkspace: true });
      expect(memberStatus).toEqual({ state: "not_trusted" });

      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await removeMember(owner, ownerWorkspace.slug, membershipId, tx);

      expect(await readHostStatusForAccount(host, tx)).toEqual({ state: "not_trusted" });
    });
  });

  it("reads an untrusted staff member of a workspace with a trusted owner as not trusted alone once staff suspend the workspace", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, OWNER_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");

      const beforeSuspension = await readHostStatusForAccount(host, tx);

      expect(beforeSuspension).toEqual({ state: "not_trusted", runsTrustedWorkspace: true });

      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await suspendInstitution(
        operator,
        ownerWorkspace.institutionId,
        "Pemeriksaan kompetisi palsu.",
        tx,
      );

      const afterSuspension = await readHostStatusForAccount(host, tx);

      expect(afterSuspension).toEqual({ state: "not_trusted" });
    });
  });
});
