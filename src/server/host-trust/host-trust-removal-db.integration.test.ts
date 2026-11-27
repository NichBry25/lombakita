// @vitest-environment node

// The staff removal of a host's trust, against real rows in a rolled-back transaction. Hosts come
// through the real sign-up and host step services, removals through the real removal route or the
// removal service, presses through the real publish route, the Email organisasi through its real
// code services and invitations through the real invitation route and accept service. A row is
// planted directly only where this file does not drive its writer, and each such helper says so.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  organizationCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  enqueueRemoved: vi.fn(async (_input: unknown) => ({})),
  enqueueApproved: vi.fn(async (_input: unknown) => ({})),
  sendRemovedEmail: vi.fn(async (_options: unknown) => undefined),
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
    enqueueCompetitionCancelled: vi.fn(async () => ({})),
    enqueueCompetitionEdited: vi.fn(async () => ({})),
    enqueueRegistrationConfirmed: vi.fn(async () => ({})),
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: mocks.enqueueApproved,
    enqueueHostTrustRemoved: mocks.enqueueRemoved,
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
    sendHostTrustRemovedEmail: mocks.sendRemovedEmail,
  };
});

// De-identification refuses to run without storage and lists stored objects. The store answers with
// none, so no test here reaches it.
vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return {
    ...actual,
    isR2Available: () => true,
    generatePresignedPutUrl: vi.fn(),
    generatePresignedGetUrl: vi.fn(),
    headObject: vi.fn(),
    readObjectHead: vi.fn(),
    deleteObject: vi.fn(),
    listObjects: vi.fn().mockResolvedValue([]),
  };
});

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
import {
  createInstitutionWorkspaceForUser,
  createPersonalInstitutionForUser,
} from "@/server/institution-workspace/institution-service";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { setCompetitionPaymentWindow } from "@/server/competitions/competition-fee-service";
import { createIndividualRegistration } from "@/server/registrations/registration-service";
import { buildQrisObjectPrefix } from "@/server/institutions/payment-instructions-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { removeHostTrust } from "./host-trust-removal-service";
import {
  DeidentificationError,
  deidentifyAccount,
} from "@/server/accounts/account-deidentification-service";
import { acceptInstitutionInvitationForUser } from "@/server/institution-invitations/invitation-service";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { PATCH as patchCompetitionRoute } from "@/app/api/v1/competitions/[competitionId]/route";
import { PUT as eligibilityRoute } from "@/app/api/v1/competitions/[competitionId]/eligibility/route";
import { PUT as tagsRoute } from "@/app/api/v1/competitions/[competitionId]/tags/route";
import { PUT as roundsRoute } from "@/app/api/v1/competitions/[competitionId]/rounds/route";
import { POST as unpublishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/unpublish/route";
import { PUT as paymentInstructionsRoute } from "@/app/api/v1/institutions/[institutionSlug]/payment-instructions/route";
import { POST as invitationsRoute } from "@/app/api/v1/institutions/[institutionSlug]/invitations/route";
import { PATCH as memberRoleRoute } from "@/app/api/v1/institutions/[institutionSlug]/members/[membershipId]/role/route";
import { PATCH as raiseRoute } from "@/app/api/platform-ops/accounts/[accountId]/recruiter-tier/route";
import { POST as removalRoute } from "@/app/api/platform-ops/accounts/[accountId]/host-trust-removal/route";
import {
  processHostTrustRemovedJob,
  type HostTrustRemovedJob,
} from "@/server/async/jobs/host-trust-removed";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";
import { serverEnv } from "@/config/env.server";
import { updateCandidateProfile } from "@/server/candidate/candidate-profile-service";
import {
  HostIdentityKeyError,
  hashHostIdentifier,
  hostIdentityKeyCheck,
  type HostIdentifierKind,
} from "./removed-host-identity";

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
  mocks.enqueueRemoved.mockClear();
  mocks.enqueueApproved.mockClear();
  mocks.sendRemovedEmail.mockClear();
  useHostIdentityKey(hostKeys.one);
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

// Planted directly: a stand-in for the operator promotion, which this file does not drive.
const plantOperator = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, userId));
  return userId;
};

const trustRemovedAtOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ hostTrustRemovedAt: schema.users.hostTrustRemovedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.hostTrustRemovedAt;
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

const latestOrganizationCode = (): string => {
  const sent = mocks.organizationCodes.at(-1);
  if (!sent) throw new Error("No Email organisasi code was sent");
  return sent.code;
};

const usernameOf = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.username;
};

type AccountDb = Parameters<typeof deidentifyAccount>[3];

// De-identification opens its own transactions, so it gets a shim whose transaction is a savepoint
// on the rolled-back test transaction.
const savepointShimFor = (tx: Database): AccountDb =>
  ({
    transaction: async (fn: (nested: Tx) => Promise<unknown>) => tx.transaction(fn),
  }) as unknown as AccountDb;

type RemovalBody = { accountId?: string; tier?: string; error?: { code: string } };

const removeThroughRoute = async (
  tx: Database,
  staffUserId: string,
  accountId: string,
  body: unknown,
): Promise<{ status: number; body: RemovalBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = staffUserId;
  const request = new Request(
    `http://localhost/api/platform-ops/accounts/${accountId}/host-trust-removal`,
    { method: "POST", body: JSON.stringify(body) },
  );
  const response = await removalRoute(request, { params: Promise.resolve({ accountId }) });
  const parsed = (await response.json()) as RemovalBody;
  return { status: response.status, body: parsed };
};

// Planted directly: a stand-in for joining through an invitation, which this file does not drive.
const plantMembership = async (
  tx: Database,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
): Promise<void> => {
  await tx.insert(schema.institutionMemberships).values({
    institutionId,
    userId,
    membershipRole,
    status: "active",
  });
};

// Planted directly: a stand-in for the owner's price setting, which this file does not drive.
const plantPaidPrice = async (tx: Database, competitionId: string): Promise<void> => {
  await tx
    .update(schema.competitions)
    .set({ feeAmount: 50_000, feeCurrency: "IDR" })
    .where(eq(schema.competitions.id, competitionId));
};

const publishAsHost = async (
  tx: Database,
  hostId: string,
): Promise<{ workspace: Workspace; draft: string }> => {
  const workspace = await ownWorkspace(tx, hostId);
  const draft = await createPublishableDraft(tx, hostId, workspace.slug, FIRST_TITLE);
  const pressed = await pressOn(tx, hostId, workspace, draft);
  if (pressed.status !== 200) throw new Error("the press did not publish");
  return { workspace, draft };
};

type EditBody = {
  competition?: { title: string };
  eligibilityNote?: string | null;
  audience?: string[] | null;
  tags?: string[];
  rounds?: Array<{ title: string }>;
  error?: { code: string; details?: { fields?: string[] } };
};

type EditRoute = (
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
) => Promise<Response>;

const sendEditThroughRoute = async (
  route: EditRoute,
  tx: Database,
  actorUserId: string,
  competitionId: string,
  request: { method: "PATCH" | "PUT"; path: string; body: unknown },
): Promise<{ status: number; body: EditBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const httpRequest = new Request(
    `http://localhost/api/v1/competitions/${competitionId}${request.path}`,
    {
      method: request.method,
      headers: { [SESSION_USER_HEADER]: actorUserId, "content-type": "application/json" },
      body: JSON.stringify(request.body),
    },
  );
  const response = await route(httpRequest, { params: Promise.resolve({ competitionId }) });
  const parsed = (await response.json()) as EditBody;
  return { status: response.status, body: parsed };
};

const patchThroughRoute = (
  tx: Database,
  actorUserId: string,
  competitionId: string,
  body: unknown,
) =>
  sendEditThroughRoute(patchCompetitionRoute, tx, actorUserId, competitionId, {
    method: "PATCH",
    path: "",
    body,
  });

const eligibilityThroughRoute = (
  tx: Database,
  actorUserId: string,
  competitionId: string,
  body: unknown,
) =>
  sendEditThroughRoute(eligibilityRoute, tx, actorUserId, competitionId, {
    method: "PUT",
    path: "/eligibility",
    body,
  });

const tagsThroughRoute = (
  tx: Database,
  actorUserId: string,
  competitionId: string,
  body: unknown,
) =>
  sendEditThroughRoute(tagsRoute, tx, actorUserId, competitionId, {
    method: "PUT",
    path: "/tags",
    body,
  });

const publicFieldsOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({
      title: schema.competitions.title,
      description: schema.competitions.description,
      category: schema.competitions.category,
      location: schema.competitions.location,
      registrationStartAt: schema.competitions.registrationStartAt,
      registrationEndAt: schema.competitions.registrationEndAt,
      eventStartAt: schema.competitions.eventStartAt,
      eventEndAt: schema.competitions.eventEndAt,
      resultAnnouncementAt: schema.competitions.resultAnnouncementAt,
      minTeamSize: schema.competitions.minTeamSize,
      maxTeamSize: schema.competitions.maxTeamSize,
      allowCancellation: schema.competitions.allowCancellation,
      cancellationCutoffDays: schema.competitions.cancellationCutoffDays,
      audience: schema.competitions.audience,
      eligibilityNote: schema.competitions.eligibilityNote,
      organizerContactValue: schema.competitions.organizerContactValue,
      paymentWindowDays: schema.competitions.paymentWindowDays,
    })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row;
};

const tagsOf = async (tx: Database, competitionId: string): Promise<string[]> => {
  const rows = await tx
    .select({ tag: schema.competitionTags.tag })
    .from(schema.competitionTags)
    .where(eq(schema.competitionTags.competitionId, competitionId));
  return rows.map((row) => row.tag).sort();
};

const roundsThroughRoute = (
  tx: Database,
  actorUserId: string,
  competitionId: string,
  body: unknown,
) =>
  sendEditThroughRoute(roundsRoute, tx, actorUserId, competitionId, {
    method: "PUT",
    path: "/rounds",
    body,
  });

const roundsOf = (tx: Database, competitionId: string) =>
  tx
    .select({
      title: schema.competitionRounds.title,
      description: schema.competitionRounds.description,
      platformLabel: schema.competitionRounds.platformLabel,
      startsAt: schema.competitionRounds.startsAt,
      endsAt: schema.competitionRounds.endsAt,
    })
    .from(schema.competitionRounds)
    .where(eq(schema.competitionRounds.competitionId, competitionId))
    .orderBy(asc(schema.competitionRounds.sortOrder));

type UnpublishBody = {
  competition?: { status: string };
  cancelledCount?: number;
  error?: { code: string };
};

const unpublishThroughRoute = async (
  tx: Database,
  actorUserId: string,
  workspace: Workspace,
  competitionId: string,
): Promise<{ status: number; body: UnpublishBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const request = new Request(
    `http://localhost/api/v1/institutions/${workspace.slug}/competitions/${competitionId}/unpublish`,
    { method: "POST", headers: { [SESSION_USER_HEADER]: actorUserId } },
  );
  const response = await unpublishRoute(request, {
    params: Promise.resolve({ institutionSlug: workspace.slug, competitionId }),
  });
  const body = (await response.json()) as UnpublishBody;
  return { status: response.status, body };
};

type PaymentBody = {
  instructions?: { accountNumber: string | null };
  error?: { code: string };
};

const paymentInstructionsThroughRoute = async (
  tx: Database,
  actorUserId: string,
  institutionSlug: string,
  body: unknown,
): Promise<{ status: number; body: PaymentBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const request = new Request(
    `http://localhost/api/v1/institutions/${institutionSlug}/payment-instructions`,
    {
      method: "PUT",
      headers: { [SESSION_USER_HEADER]: actorUserId, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await paymentInstructionsRoute(request, {
    params: Promise.resolve({ institutionSlug }),
  });
  const parsed = (await response.json()) as PaymentBody;
  return { status: response.status, body: parsed };
};

const instructionsOf = async (tx: Database, institutionId: string) => {
  const [row] = await tx
    .select({
      accountNumber: schema.institutionPaymentInstructions.accountNumber,
      qrisR2Key: schema.institutionPaymentInstructions.qrisR2Key,
    })
    .from(schema.institutionPaymentInstructions)
    .where(eq(schema.institutionPaymentInstructions.institutionId, institutionId));
  return row ?? null;
};

const registrationStatusOf = async (tx: Database, registrationId: string) => {
  const [row] = await tx
    .select({ status: schema.competitionRegistrations.status })
    .from(schema.competitionRegistrations)
    .where(eq(schema.competitionRegistrations.id, registrationId));
  if (!row) throw new Error("No registration row");
  return row.status;
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

const runRemovalJob = (payload: unknown) =>
  processHostTrustRemovedJob({
    id: "job_removal",
    data: payload,
  } as unknown as HostTrustRemovedJob);

const HOST_ADDRESS = "budi.host@acme.example";
const SECOND_HOST_ADDRESS = "sari.host@acme.example";
const OPERATOR_ADDRESS = "ops.staf@acme.example";
const OTHER_ADDRESS = "dina@example.test";
const ORGANIZATION_ADDRESS = "budi.kerja@acme.example";
const REASON = "Kontak palsu di beberapa kompetisi.";
const REMOVED_TITLE = "Status tepercaya Anda dicabut";
const REMOVED_BODY = `Alasan: ${REASON} Kompetisi yang sudah tayang tetap tayang. Kompetisi berikutnya diperiksa staf sebelum tayang.`;

describe.skipIf(skipWithoutDatabase)("the staff removal of a host's trust (rolled back)", () => {
  it("removes the trust of a trusted host through the route, keeps its published competition and sends the notice", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      expect(await tierOf(tx, host)).toBe("elevated");
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      const published = await pressOn(tx, host, workspace, draft);
      expect(published.status).toBe(200);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const removed = await removeThroughRoute(tx, operator, host, {
        reason: "  Kontak palsu di beberapa kompetisi.  ",
      });

      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ accountId: host, tier: "minimal" });
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await trustRemovedAtOf(tx, host)).toEqual(expect.any(Date));
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await auditRowsOf(tx, host)).toEqual([
        {
          actorUserId: operator,
          eventType: "host_trust.removed",
          reason: REASON,
          metadata: { from: "elevated", to: "minimal" },
        },
      ]);
      expect(mocks.enqueueRemoved).toHaveBeenCalledWith({
        userId: host,
        reason: REASON,
        epoch: expect.any(Number),
      });

      await runRemovalJob(mocks.enqueueRemoved.mock.calls[0]![0]);

      expect(await inboxOf(tx, host)).toEqual([{ title: REMOVED_TITLE, body: REMOVED_BODY }]);
      expect(mocks.sendRemovedEmail).toHaveBeenCalledWith({
        toEmail: HOST_ADDRESS,
        recipientId: host,
        title: REMOVED_TITLE,
        body: REMOVED_BODY,
      });
    });
  });

  it("lowers only the named account", async () => {
    await inRollback(async (tx) => {
      const hostA = await signUpHost(tx, HOST_ADDRESS);
      const hostB = await signUpHost(tx, SECOND_HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const removed = await removeThroughRoute(tx, operator, hostA, { reason: REASON });

      expect(removed.status).toBe(200);
      expect(await tierOf(tx, hostA)).toBe("minimal");
      expect(await tierOf(tx, hostB)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, hostB)).toBeNull();
    });
  });

  it("lowers a trusted tier only with the opt-in its own transaction set", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const result = await removeHostTrust(operator, host, REASON, tx);

      expect(result).toEqual({ accountId: host, tier: "minimal" });
      expect(await tierOf(tx, host)).toBe("minimal");
    });
  });

  it("refuses a removal by an account that is not platform_ops and by the host's own operator account, and changes nothing", async () => {
    await inRollback(async (tx) => {
      const other = await signUpParticipant(tx, OTHER_ADDRESS);
      const host = await signUpHost(tx, HOST_ADDRESS);

      const byParticipant = await removeThroughRoute(tx, other, host, { reason: REASON });

      expect(byParticipant.status).toBe(403);
      expect(byParticipant.body.error?.code).toBe("operator_actor_not_platform_ops");

      // Planted directly: a stand-in for the operator promotion of the host itself.
      await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, host));

      const bySelf = await removeThroughRoute(tx, host, host, { reason: REASON });

      expect(bySelf.status).toBe(403);
      expect(bySelf.body.error?.code).toBe("operator_actor_is_target");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, host)).toBeNull();
      expect(await auditRowsOf(tx, host)).toEqual([]);
      expect(mocks.enqueueRemoved).not.toHaveBeenCalled();
    });
  });

  it("refuses a removal without a reason of 1 to 1000 characters and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      for (const body of [{}, { reason: "   " }, { reason: "a".repeat(1001) }]) {
        const refused = await removeThroughRoute(tx, operator, host, body);
        expect(refused.status).toBe(400);
        expect(refused.body.error?.code).toBe("host_trust_reason_required");
      }

      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await auditRowsOf(tx, host)).toEqual([]);
      expect(mocks.enqueueRemoved).not.toHaveBeenCalled();
    });
  });

  it("refuses an account that is not trusted, a second removal and an unknown account", async () => {
    await inRollback(async (tx) => {
      const participant = await signUpParticipant(tx, OTHER_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const notTrusted = await removeThroughRoute(tx, operator, participant, { reason: REASON });

      expect(notTrusted.status).toBe(409);
      expect(notTrusted.body.error?.code).toBe("host_trust_not_trusted");
      expect(await trustRemovedAtOf(tx, participant)).toBeNull();

      const host = await signUpHost(tx, HOST_ADDRESS);
      const first = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(first.status).toBe(200);

      const second = await removeThroughRoute(tx, operator, host, { reason: REASON });

      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("host_trust_not_trusted");
      expect((await auditRowsOf(tx, host)).map((row) => row.eventType)).toEqual([
        "host_trust.removed",
      ]);

      const unknown = await removeThroughRoute(tx, operator, randomUUID(), { reason: REASON });

      expect(unknown.status).toBe(404);
      expect(unknown.body.error?.code).toBe("host_trust_account_not_found");
      expect(mocks.enqueueRemoved).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses the removal of a de-identified account and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await deidentifyAccount(
        operator,
        host,
        { confirmUsername: await usernameOf(tx, host), reason: "permintaan pemilik" },
        savepointShimFor(tx),
      );
      expect(await tierOf(tx, host)).toBe("elevated");

      const refused = await removeThroughRoute(tx, operator, host, { reason: REASON });

      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("account_deactivated");
      expect(await tierOf(tx, host)).toBe("elevated");
      // The de-identification writes its own audit row, which this assertion leaves aside.
      expect(
        (await auditRowsOf(tx, host)).filter((row) => row.eventType === "host_trust.removed"),
      ).toEqual([]);
      expect(mocks.enqueueRemoved).not.toHaveBeenCalled();
    });
  });

  it("keeps a removed host untrusted through an Email organisasi confirm and sends its next press to a host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(removed.status).toBe(200);

      await issueOrganizationEmailCode(host, ORGANIZATION_ADDRESS, tx);
      const confirmed = await confirmOrganizationEmailCode(host, latestOrganizationCode(), tx);

      expect(confirmed).toEqual({ email: ORGANIZATION_ADDRESS, trustSource: null });
      expect(await tierOf(tx, host)).toBe("minimal");

      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(pressed.body.hostCheck?.status).toBe("pending_review");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await tierOf(tx, host)).toBe("minimal");
    });
  });
});

const LOCAL_HOST_ADDRESS = "budi.lokal@seed.lombakita.local";

const useHostIdentityKey = (value: string | undefined) => {
  (serverEnv as { hostIdentityHashKey?: string }).hostIdentityHashKey = value;
};

// Planted directly: inside one test transaction a removal and a record share one clock, so the
// removal is moved back to tell them apart, or to stand in for an old removal no path writes.
const backdateRemoval = async (tx: Database, userId: string, interval: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ hostTrustRemovedAt: sql`now() - ${interval}::interval` })
    .where(eq(schema.users.id, userId));
};

// Planted directly: stands in for the daily purge, which deletes a record 2 years after its removal.
const purgeRecordOf = async (tx: Database, userId: string): Promise<void> => {
  await tx.delete(schema.hostTrustRemovals).where(eq(schema.hostTrustRemovals.userId, userId));
};

const recordsOf = (tx: Database, userId: string) =>
  tx.select().from(schema.hostTrustRemovals).where(eq(schema.hostTrustRemovals.userId, userId));

const removalTimeMatchesAccount = async (tx: Database, userId: string): Promise<boolean> => {
  const [row] = await tx
    .select({
      matches: sql<boolean>`${schema.hostTrustRemovals.removedAt} = ${schema.users.hostTrustRemovedAt}`,
    })
    .from(schema.hostTrustRemovals)
    .innerJoin(schema.users, eq(schema.users.id, schema.hostTrustRemovals.userId))
    .where(eq(schema.hostTrustRemovals.userId, userId));
  return row?.matches ?? false;
};

const hashesOf = (kind: HostIdentifierKind, values: string[]): string[] =>
  values.map((value) => hashHostIdentifier(kind, value)).sort();

const sortedCopy = (values: string[]): string[] => [...values].sort();

// A removed host's confirm saves the address without trusting it, so this serves a trusted and a
// removed host alike.
const confirmOrganizationEmail = async (
  tx: Database,
  userId: string,
  address: string,
): Promise<void> => {
  await issueOrganizationEmailCode(userId, address, tx);
  await confirmOrganizationEmailCode(userId, latestOrganizationCode(), tx);
};

const signUpHostTrustedByOrganizationEmail = async (tx: Database): Promise<string> => {
  const host = await signUpHost(tx, LOCAL_HOST_ADDRESS);
  await confirmOrganizationEmail(tx, host, "Budi+Lomba@Acme.example");
  return host;
};

const accountRowOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ status: schema.users.status, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row;
};

const organizationEmailRowsOf = (tx: Database, userId: string) =>
  tx
    .select()
    .from(schema.hostOrganizationEmails)
    .where(eq(schema.hostOrganizationEmails.userId, userId));

describe.skipIf(skipWithoutDatabase)("the trust removal record (rolled back)", () => {
  it("records the removed host's sign-in email, Email organisasi and sign-up phone with its organization domain, dated from the removal, when staff remove its trust through the route", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHostTrustedByOrganizationEmail(tx);
      expect(await tierOf(tx, host)).toBe("elevated");
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });

      expect(removed.status).toBe(200);
      const records = await recordsOf(tx, host);
      expect(records).toHaveLength(1);
      expect(records[0]?.userId).toBe(host);
      expect(sortedCopy(records[0]?.emailHashes ?? [])).toEqual(
        hashesOf("email", ["budi.lokal@seed.lombakita.local", "budi@acme.example"]),
      );
      expect(sortedCopy(records[0]?.phoneHashes ?? [])).toEqual(hashesOf("phone", ["62812345678"]));
      expect(records[0]?.organizationDomain).toBe("acme.example");
      expect(records[0]?.keyCheck).toBe(hostIdentityKeyCheck());
      expect(await removalTimeMatchesAccount(tx, host)).toBe(true);
    });
  });

  it("refuses a removal whose record cannot be written and leaves the host trusted, with no removal, no audit row and no record", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHostTrustedByOrganizationEmail(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      useHostIdentityKey(undefined);

      const refusal = await removeHostTrust(operator, host, REASON, tx).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(refusal).toBeInstanceOf(HostIdentityKeyError);
      expect((refusal as HostIdentityKeyError).code).toBe("host_identity_key_missing");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, host)).toBeNull();
      const removalAuditRows = (await auditRowsOf(tx, host)).filter(
        (row) => row.eventType === "host_trust.removed",
      );
      expect(removalAuditRows).toEqual([]);
      expect(await recordsOf(tx, host)).toEqual([]);
      expect(mocks.enqueueRemoved).not.toHaveBeenCalled();
    });
  });

  it("keeps the record through the account's deletion and adds the Email organisasi and sign-up phone it changed after the removal, with the removal time unchanged", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHostTrustedByOrganizationEmail(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(removed.status).toBe(200);
      const removedAt = await trustRemovedAtOf(tx, host);
      await confirmOrganizationEmail(tx, host, "baru@acme.example");
      await updateCandidateProfile(host, { phoneNumber: "0823-4444-5555" }, tx);

      await deidentifyAccount(
        operator,
        host,
        { confirmUsername: await usernameOf(tx, host), reason: "permintaan pemilik" },
        savepointShimFor(tx),
      );

      const records = await recordsOf(tx, host);
      expect(records).toHaveLength(1);
      expect(records[0]?.userId).toBe(host);
      expect(sortedCopy(records[0]?.emailHashes ?? [])).toEqual(
        hashesOf("email", [
          "budi.lokal@seed.lombakita.local",
          "budi@acme.example",
          "baru@acme.example",
        ]),
      );
      expect(sortedCopy(records[0]?.phoneHashes ?? [])).toEqual(
        hashesOf("phone", ["62812345678", "6282344445555"]),
      );
      expect(records[0]?.organizationDomain).toBe("acme.example");
      expect(records[0]?.removedAt).toEqual(removedAt);
      expect(await removalTimeMatchesAccount(tx, host)).toBe(true);
      expect(await organizationEmailRowsOf(tx, host)).toEqual([]);
    });
  });

  it("writes no record when an account whose trust staff never removed is deleted", async () => {
    await inRollback(async (tx) => {
      const dewi = await signUpHost(tx, "dewi.lokal@seed.lombakita.local");
      await confirmOrganizationEmail(tx, dewi, "dewi@acme.example");
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);

      await deidentifyAccount(
        operator,
        dewi,
        { confirmUsername: await usernameOf(tx, dewi), reason: "permintaan pemilik" },
        savepointShimFor(tx),
      );

      expect(await recordsOf(tx, dewi)).toEqual([]);
    });
  });

  it("writes no record when an account whose removal is older than 2 years is deleted", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHostTrustedByOrganizationEmail(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(removed.status).toBe(200);
      await purgeRecordOf(tx, host);
      await backdateRemoval(tx, host, "2 years 1 day");

      await deidentifyAccount(
        operator,
        host,
        { confirmUsername: await usernameOf(tx, host), reason: "permintaan pemilik" },
        savepointShimFor(tx),
      );

      expect(await recordsOf(tx, host)).toEqual([]);
    });
  });

  it("refuses to delete a removed account while its record cannot be written, and changes nothing", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHostTrustedByOrganizationEmail(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(removed.status).toBe(200);
      const expectedEmailHashes = hashesOf("email", [
        "budi.lokal@seed.lombakita.local",
        "budi@acme.example",
      ]);
      useHostIdentityKey(undefined);

      const refusal = await deidentifyAccount(
        operator,
        host,
        { confirmUsername: await usernameOf(tx, host), reason: "permintaan pemilik" },
        savepointShimFor(tx),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(refusal).toBeInstanceOf(DeidentificationError);
      expect((refusal as DeidentificationError).code).toBe("deidentify_rehearsal_failed");
      expect(await accountRowOf(tx, host)).toEqual({
        status: "active",
        email: LOCAL_HOST_ADDRESS,
      });
      const records = await recordsOf(tx, host);
      expect(records).toHaveLength(1);
      expect(sortedCopy(records[0]?.emailHashes ?? [])).toEqual(expectedEmailHashes);
    });
  });
});

const NEW_TITLE = "Lomba Esai Nasional Terbaru";
const HELD_REFUSAL_CODE = "competition_public_edit_blocked_trust_removed";
const WITHDRAWAL_REFUSAL_CODE = "competition_unpublish_blocked_trust_removed";
const PAYMENT_REFUSAL_CODE = "payment_instructions_blocked_trust_removed";
const SECOND_TITLE = "Lomba Poster Digital";
const ROUND_ONE = {
  title: "Penyisihan",
  description: "Unggah esai pertama.",
  platformLabel: "Zoom",
  startsAt: "2030-03-01T02:00:00.000Z",
  endsAt: "2030-03-02T02:00:00.000Z",
};
const ROUND_TWO = {
  title: "Final",
  description: "Presentasi di depan juri.",
  platformLabel: "Google Meet",
  startsAt: "2030-03-05T02:00:00.000Z",
  endsAt: "2030-03-06T02:00:00.000Z",
};
const BANK_ACCOUNT = {
  bankName: "Bank Mandiri",
  accountNumber: "1370012345678",
  accountHolderName: "Budi Santoso",
  qrisR2Key: null,
  instructionsNote: null,
};

// A trusted host publishes through the real press, then staff remove its trust through the real
// removal route, so the account is the one the guard has to hold.
const hostWithLiveCompetitionAfterTrustRemoval = async (
  tx: Database,
): Promise<{ host: string; workspace: Workspace; draft: string; operator: string }> => {
  const host = await signUpHost(tx, HOST_ADDRESS);
  const { workspace, draft } = await publishAsHost(tx, host);
  const operator = await plantOperator(tx, OPERATOR_ADDRESS);
  const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
  expect(removed.status).toBe(200);
  return { host, workspace, draft, operator };
};

// The rounds are written through the real route while the host is trusted, the competition goes
// live through the real press, and the trust is removed through the real removal route.
const hostWithLiveRoundsAfterTrustRemoval = async (
  tx: Database,
): Promise<{ host: string; workspace: Workspace; draft: string; operator: string }> => {
  const host = await signUpHost(tx, HOST_ADDRESS);
  const workspace = await ownWorkspace(tx, host);
  const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
  const saved = await roundsThroughRoute(tx, host, draft, { rounds: [ROUND_ONE, ROUND_TWO] });
  if (saved.status !== 200) throw new Error("the rounds were not saved");
  const pressed = await pressOn(tx, host, workspace, draft);
  if (pressed.status !== 200) throw new Error("the press did not publish");
  const operator = await plantOperator(tx, OPERATOR_ADDRESS);
  const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
  expect(removed.status).toBe(200);
  return { host, workspace, draft, operator };
};

describe.skipIf(skipWithoutDatabase)(
  "what a host whose trust staff removed may change on a live competition (rolled back)",
  () => {
    it("refuses a host whose trust staff removed a new title, close date or cancellation policy on a live competition and keeps them", async () => {
      await inRollback(async (tx) => {
        const { host, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);
        const before = await publicFieldsOf(tx, draft);
        const storedClose = before.registrationEndAt;
        if (!storedClose) throw new Error("The published competition has no close date");

        const retitled = await patchThroughRoute(tx, host, draft, { title: NEW_TITLE });

        expect(retitled.status).toBe(403);
        expect(retitled.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(retitled.body.error?.details?.fields).toEqual(["title"]);
        expect((await publicFieldsOf(tx, draft)).title).toBe(FIRST_TITLE);

        const laterClose = new Date(storedClose.getTime() + 2 * DAY).toISOString();
        const moved = await patchThroughRoute(tx, host, draft, { registrationEndAt: laterClose });

        expect(moved.status).toBe(403);
        expect(moved.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(moved.body.error?.details?.fields).toEqual(["registrationEndAt"]);
        expect((await publicFieldsOf(tx, draft)).registrationEndAt).toEqual(storedClose);

        const cancellable = await patchThroughRoute(tx, host, draft, {
          allowCancellation: true,
          cancellationCutoffDays: 3,
        });

        expect(cancellable.status).toBe(403);
        expect(cancellable.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(cancellable.body.error?.details?.fields).toEqual([
          "allowCancellation",
          "cancellationCutoffDays",
        ]);
        const after = await publicFieldsOf(tx, draft);
        expect(after.allowCancellation).toBe(false);
        expect(after.cancellationCutoffDays).toBeNull();
      });
    });

    it("refuses a host whose trust staff removed a new audience or eligibility note on a live competition, and saves the stored ones", async () => {
      await inRollback(async (tx) => {
        const { host, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);

        const widened = await eligibilityThroughRoute(tx, host, draft, {
          eligibilityNote: null,
          audience: ["umum", "mahasiswa"],
        });

        expect(widened.status).toBe(403);
        expect(widened.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(widened.body.error?.details?.fields).toEqual(["audience"]);
        expect((await publicFieldsOf(tx, draft)).audience).toEqual(["umum"]);

        const noted = await eligibilityThroughRoute(tx, host, draft, {
          eligibilityNote: "Terbuka untuk semua jenjang.",
          audience: ["umum"],
        });

        expect(noted.status).toBe(403);
        expect(noted.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(noted.body.error?.details?.fields).toEqual(["eligibilityNote"]);
        expect((await publicFieldsOf(tx, draft)).eligibilityNote).toBeNull();

        const resent = await eligibilityThroughRoute(tx, host, draft, {
          eligibilityNote: null,
          audience: ["umum"],
        });

        expect(resent.status).toBe(200);
        const after = await publicFieldsOf(tx, draft);
        expect(after.eligibilityNote).toBeNull();
        expect(after.audience).toEqual(["umum"]);
      });
    });

    it("lets a host whose trust staff removed change the contact and resend unchanged public values of a live competition", async () => {
      await inRollback(async (tx) => {
        const { host, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);

        const contact = await setCompetitionOrganizerContactForEditor(
          host,
          draft,
          { kind: "whatsapp", value: "081211112222" },
          tx,
        );

        expect(contact).toEqual({ kind: "whatsapp", value: "6281211112222" });
        expect((await publicFieldsOf(tx, draft)).organizerContactValue).toBe("6281211112222");

        const resent = await patchThroughRoute(tx, host, draft, { title: FIRST_TITLE });

        expect(resent.status).toBe(200);
        expect(resent.body.competition?.title).toBe(FIRST_TITLE);
      });
    });

    it("lets another member of the workspace change the title of a live competition after the host's trust was removed", async () => {
      await inRollback(async (tx) => {
        const { workspace, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);
        const staff = await signUpHost(tx, SECOND_HOST_ADDRESS);
        await plantMembership(tx, workspace.institutionId, staff, "institution_staff");

        const retitled = await patchThroughRoute(tx, staff, draft, { title: NEW_TITLE });

        expect(retitled.status).toBe(200);
        expect((await publicFieldsOf(tx, draft)).title).toBe(NEW_TITLE);
      });
    });

    it("lets a host whose trust staff removed edit the title, the audience and the tags of a draft", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, HOST_ADDRESS);
        const workspace = await ownWorkspace(tx, host);
        const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
        const operator = await plantOperator(tx, OPERATOR_ADDRESS);
        const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
        expect(removed.status).toBe(200);

        const retitled = await patchThroughRoute(tx, host, draft, { title: NEW_TITLE });
        expect(retitled.status).toBe(200);

        const widened = await eligibilityThroughRoute(tx, host, draft, {
          eligibilityNote: null,
          audience: ["umum", "mahasiswa"],
        });
        expect(widened.status).toBe(200);
        const after = await publicFieldsOf(tx, draft);
        expect(after.title).toBe(NEW_TITLE);
        expect(after.audience).toEqual(["umum", "mahasiswa"]);

        const tagged = await tagsThroughRoute(tx, host, draft, { tags: ["Esai"] });
        expect(tagged.status).toBe(200);
        expect(await tagsOf(tx, draft)).toEqual(["Esai"]);
      });
    });

    it("refuses a host whose trust staff removed new tags on a live competition, and saves the stored set", async () => {
      await inRollback(async (tx) => {
        const { host, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);

        const added = await tagsThroughRoute(tx, host, draft, { tags: ["Esai", "Debat"] });

        expect(added.status).toBe(403);
        expect(added.body.error?.code).toBe(HELD_REFUSAL_CODE);
        expect(added.body.error?.details?.fields).toEqual(["tags"]);
        expect(await tagsOf(tx, draft)).toEqual([]);

        const resent = await tagsThroughRoute(tx, host, draft, { tags: [] });

        expect(resent.status).toBe(200);
        expect(resent.body.tags).toEqual([]);
      });
    });

    it("lets a host whose trust staff removed move the payment window of a live paid competition", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, HOST_ADDRESS);
        const { draft } = await publishAsHost(tx, host);
        await plantPaidPrice(tx, draft);
        const operator = await plantOperator(tx, OPERATOR_ADDRESS);
        const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
        expect(removed.status).toBe(200);

        await expect(setCompetitionPaymentWindow(host, draft, 5, tx)).resolves.toBeUndefined();

        expect((await publicFieldsOf(tx, draft)).paymentWindowDays).toBe(5);
      });
    });

    const dayAfter = (stored: Date | null): string => {
      if (!stored) throw new Error("The published competition has no stored date");
      return new Date(stored.getTime() + DAY).toISOString();
    };

    type HeldFieldRow = {
      field: keyof Awaited<ReturnType<typeof publicFieldsOf>>;
      value: (before: Awaited<ReturnType<typeof publicFieldsOf>>) => unknown;
    };

    const HELD_FIELD_ROWS: HeldFieldRow[] = [
      { field: "title", value: () => NEW_TITLE },
      { field: "description", value: () => "Deskripsi kompetisi yang diubah." },
      { field: "category", value: () => "essay" },
      { field: "location", value: () => "offline" },
      { field: "registrationStartAt", value: (before) => dayAfter(before.registrationStartAt) },
      { field: "registrationEndAt", value: (before) => dayAfter(before.registrationEndAt) },
      { field: "eventStartAt", value: (before) => dayAfter(before.eventStartAt) },
      { field: "eventEndAt", value: (before) => dayAfter(before.eventEndAt) },
      { field: "resultAnnouncementAt", value: (before) => dayAfter(before.resultAnnouncementAt) },
      { field: "allowCancellation", value: () => true },
      { field: "cancellationCutoffDays", value: () => 3 },
      { field: "minTeamSize", value: () => 2 },
      { field: "maxTeamSize", value: () => 5 },
    ];

    it.each(HELD_FIELD_ROWS)(
      "refuses a host whose trust staff removed a new $field on a live competition and keeps the stored value",
      async ({ field, value }) => {
        await inRollback(async (tx) => {
          const { host, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);
          const before = await publicFieldsOf(tx, draft);

          const refused = await patchThroughRoute(tx, host, draft, { [field]: value(before) });

          expect(refused.status).toBe(403);
          expect(refused.body.error?.code).toBe(HELD_REFUSAL_CODE);
          expect(refused.body.error?.details?.fields).toEqual([field]);
          expect((await publicFieldsOf(tx, draft))[field]).toEqual(before[field]);
        });
      },
    );

    it("lets a host edit the title of a live competition again once staff raise the trust it lost", async () => {
      await inRollback(async (tx) => {
        const { host, draft, operator } = await hostWithLiveCompetitionAfterTrustRemoval(tx);

        const refused = await patchThroughRoute(tx, host, draft, { title: NEW_TITLE });

        expect(refused.status).toBe(403);

        const raised = await raiseThroughRoute(tx, operator, host);

        expect(raised.status).toBe(200);
        expect(await trustRemovedAtOf(tx, host)).toBeNull();

        const retitled = await patchThroughRoute(tx, host, draft, { title: NEW_TITLE });

        expect(retitled.status).toBe(200);
        expect((await publicFieldsOf(tx, draft)).title).toBe(NEW_TITLE);
      });
    });

    type RoundChangeRow = {
      change: string;
      rounds: Array<Record<string, string | null>>;
    };

    const ROUND_CHANGE_ROWS: RoundChangeRow[] = [
      { change: "title", rounds: [{ ...ROUND_ONE, title: "Penyisihan Daring" }, ROUND_TWO] },
      {
        change: "description",
        rounds: [{ ...ROUND_ONE, description: "Unggah esai kedua." }, ROUND_TWO],
      },
      {
        change: "platform label",
        rounds: [{ ...ROUND_ONE, platformLabel: "Microsoft Teams" }, ROUND_TWO],
      },
      {
        change: "start",
        rounds: [{ ...ROUND_ONE, startsAt: "2030-03-01T03:00:00.000Z" }, ROUND_TWO],
      },
      { change: "end", rounds: [{ ...ROUND_ONE, endsAt: "2030-03-03T02:00:00.000Z" }, ROUND_TWO] },
      { change: "order", rounds: [ROUND_TWO, ROUND_ONE] },
    ];

    it.each(ROUND_CHANGE_ROWS)(
      "refuses a host whose trust staff removed rounds with a new $change on a live competition and keeps the rounds",
      async ({ rounds }) => {
        await inRollback(async (tx) => {
          const { host, draft } = await hostWithLiveRoundsAfterTrustRemoval(tx);
          const before = await roundsOf(tx, draft);

          const refused = await roundsThroughRoute(tx, host, draft, { rounds });

          expect(refused.status).toBe(403);
          expect(refused.body.error?.code).toBe(HELD_REFUSAL_CODE);
          expect(refused.body.error?.details?.fields).toEqual(["rounds"]);
          expect(await roundsOf(tx, draft)).toEqual(before);
        });
      },
    );

    it("lets a host whose trust staff removed resend the stored rounds of a live competition and set the rounds of a draft", async () => {
      await inRollback(async (tx) => {
        const { host, workspace, draft } = await hostWithLiveRoundsAfterTrustRemoval(tx);

        const resent = await roundsThroughRoute(tx, host, draft, {
          rounds: [ROUND_ONE, ROUND_TWO],
        });

        expect(resent.status).toBe(200);
        expect(resent.body.rounds?.map((round) => round.title)).toEqual(["Penyisihan", "Final"]);

        const secondDraft = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
        const set = await roundsThroughRoute(tx, host, secondDraft, { rounds: [ROUND_ONE] });

        expect(set.status).toBe(200);
        expect((await roundsOf(tx, secondDraft)).map((round) => round.title)).toEqual([
          "Penyisihan",
        ]);
      });
    });

    it("refuses a host whose trust staff removed the withdrawal of a live competition and keeps its registration", async () => {
      await inRollback(async (tx) => {
        const { host, workspace, draft } = await hostWithLiveCompetitionAfterTrustRemoval(tx);
        const candidate = await signUpParticipant(tx, OTHER_ADDRESS);
        const registration = await createIndividualRegistration(candidate, draft, tx);

        const refused = await unpublishThroughRoute(tx, host, workspace, draft);

        expect(refused.status).toBe(403);
        expect(refused.body.error?.code).toBe(WITHDRAWAL_REFUSAL_CODE);
        expect(await competitionStatusOf(tx, draft)).toBe("published");
        expect(await registrationStatusOf(tx, registration.id)).toBe("confirmed");
      });
    });

    it("lets staff of the workspace change the rounds and withdraw a live competition after the host's trust was removed", async () => {
      await inRollback(async (tx) => {
        const { workspace, draft } = await hostWithLiveRoundsAfterTrustRemoval(tx);
        const staff = await signUpHost(tx, SECOND_HOST_ADDRESS);
        await plantMembership(tx, workspace.institutionId, staff, "institution_staff");
        const candidate = await signUpParticipant(tx, OTHER_ADDRESS);
        const registration = await createIndividualRegistration(candidate, draft, tx);

        const renamed = await roundsThroughRoute(tx, staff, draft, {
          rounds: [{ ...ROUND_ONE, title: "Penyisihan Daring" }, ROUND_TWO],
        });

        expect(renamed.status).toBe(200);
        expect((await roundsOf(tx, draft)).map((round) => round.title)).toEqual([
          "Penyisihan Daring",
          "Final",
        ]);

        const withdrawn = await unpublishThroughRoute(tx, staff, workspace, draft);

        expect(withdrawn.status).toBe(200);
        expect(withdrawn.body.cancelledCount).toBe(1);
        expect(await competitionStatusOf(tx, draft)).toBe("draft");
        expect(await registrationStatusOf(tx, registration.id)).toBe("cancelled");
      });
    });

    it("refuses an owner whose trust staff removed a new account or QRIS in the payment instructions and keeps the stored ones", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, HOST_ADDRESS);
        const workspace = await ownWorkspace(tx, host);

        const saved = await paymentInstructionsThroughRoute(tx, host, workspace.slug, BANK_ACCOUNT);

        expect(saved.status).toBe(200);
        expect(saved.body.instructions?.accountNumber).toBe("1370012345678");

        const operator = await plantOperator(tx, OPERATOR_ADDRESS);
        const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
        expect(removed.status).toBe(200);

        const newAccount = await paymentInstructionsThroughRoute(tx, host, workspace.slug, {
          ...BANK_ACCOUNT,
          accountNumber: "9990012345678",
        });

        expect(newAccount.status).toBe(403);
        expect(newAccount.body.error?.code).toBe(PAYMENT_REFUSAL_CODE);
        expect(await instructionsOf(tx, workspace.institutionId)).toEqual({
          accountNumber: "1370012345678",
          qrisR2Key: null,
        });

        const newQris = await paymentInstructionsThroughRoute(tx, host, workspace.slug, {
          ...BANK_ACCOUNT,
          qrisR2Key: buildQrisObjectPrefix(workspace.institutionId) + "qris-baru",
        });

        expect(newQris.status).toBe(403);
        expect(newQris.body.error?.code).toBe(PAYMENT_REFUSAL_CODE);
        expect(await instructionsOf(tx, workspace.institutionId)).toEqual({
          accountNumber: "1370012345678",
          qrisR2Key: null,
        });
      });
    });
  },
);

const THIRD_HOST_ADDRESS = "rudi.host@acme.example";
const INVITATION_REFUSAL_CODE = "invitation_blocked_trust_removed";
const ROLE_REFUSAL_CODE = "member_role_blocked_trust_removed";
const ACCEPT_REFUSAL_CODE = "invitation_inviter_trust_removed";
// The verified roles a host who took the host step carries in a session.
const ACCEPTING_ROLES = ["candidate", "recruiter"] as const;
const WORKSPACE_DETAILS = {
  displayName: "Komunitas Lomba Bandung",
  institutionType: "campus_organization",
};

// A personal workspace refuses every invitation, so these tests need a full one.
const fullWorkspace = async (tx: Database, ownerId: string): Promise<Workspace> => {
  const workspace = await createInstitutionWorkspaceForUser(ownerId, WORKSPACE_DETAILS, tx);
  return { institutionId: workspace.institutionId, slug: workspace.slug };
};

type InvitationBody = { invitation?: { id: string }; error?: { code: string } };

const inviteThroughRoute = async (
  tx: Database,
  actorUserId: string,
  institutionSlug: string,
  body: unknown,
): Promise<{ status: number; body: InvitationBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const request = new Request(
    `http://localhost/api/v1/institutions/${institutionSlug}/invitations`,
    {
      method: "POST",
      headers: { [SESSION_USER_HEADER]: actorUserId, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await invitationsRoute(request, {
    params: Promise.resolve({ institutionSlug }),
  });
  const parsed = (await response.json()) as InvitationBody;
  return { status: response.status, body: parsed };
};

type RoleBody = { updated?: boolean; error?: { code: string } };

const roleThroughRoute = async (
  tx: Database,
  actorUserId: string,
  institutionSlug: string,
  membershipId: string,
  body: unknown,
): Promise<{ status: number; body: RoleBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const request = new Request(
    `http://localhost/api/v1/institutions/${institutionSlug}/members/${membershipId}/role`,
    {
      method: "PATCH",
      headers: { [SESSION_USER_HEADER]: actorUserId, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await memberRoleRoute(request, {
    params: Promise.resolve({ institutionSlug, membershipId }),
  });
  const parsed = (await response.json()) as RoleBody;
  return { status: response.status, body: parsed };
};

const membershipOf = async (tx: Database, institutionId: string, userId: string) => {
  const [row] = await tx
    .select({
      id: schema.institutionMemberships.id,
      membershipRole: schema.institutionMemberships.membershipRole,
    })
    .from(schema.institutionMemberships)
    .where(
      and(
        eq(schema.institutionMemberships.institutionId, institutionId),
        eq(schema.institutionMemberships.userId, userId),
        eq(schema.institutionMemberships.status, "active"),
      ),
    );
  if (!row) throw new Error("No membership row");
  return row;
};

const invitedRolesOf = async (tx: Database, institutionId: string): Promise<string[]> => {
  const rows = await tx
    .select({ invitedRole: schema.institutionInvitations.invitedRole })
    .from(schema.institutionInvitations)
    .where(eq(schema.institutionInvitations.institutionId, institutionId))
    .orderBy(asc(schema.institutionInvitations.createdAt));
  return rows.map((row) => row.invitedRole);
};

const invitationOf = async (tx: Database, invitationId: string) => {
  const [row] = await tx
    .select({
      status: schema.institutionInvitations.status,
      acceptedAt: schema.institutionInvitations.acceptedAt,
    })
    .from(schema.institutionInvitations)
    .where(eq(schema.institutionInvitations.id, invitationId));
  if (!row) throw new Error("No invitation row");
  return row;
};

const hasActiveMembership = async (
  tx: Database,
  institutionId: string,
  userId: string,
): Promise<boolean> => {
  const rows = await tx
    .select({ id: schema.institutionMemberships.id })
    .from(schema.institutionMemberships)
    .where(
      and(
        eq(schema.institutionMemberships.institutionId, institutionId),
        eq(schema.institutionMemberships.userId, userId),
        eq(schema.institutionMemberships.status, "active"),
      ),
    );
  return rows.length > 0;
};

// The host owns a full workspace, then staff remove the host's trust through the real removal route.
const hostWithWorkspaceAfterTrustRemoval = async (
  tx: Database,
): Promise<{ host: string; workspace: Workspace }> => {
  const host = await signUpHost(tx, HOST_ADDRESS);
  const workspace = await fullWorkspace(tx, host);
  const operator = await plantOperator(tx, OPERATOR_ADDRESS);
  const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
  expect(removed.status).toBe(200);
  return { host, workspace };
};

// A second owner joins the workspace before staff remove the first owner's trust.
const coOwnedWorkspaceAfterTrustRemoval = async (
  tx: Database,
): Promise<{ host: string; coOwner: string; workspace: Workspace }> => {
  const host = await signUpHost(tx, HOST_ADDRESS);
  const workspace = await fullWorkspace(tx, host);
  const coOwner = await signUpHost(tx, SECOND_HOST_ADDRESS);
  await plantMembership(tx, workspace.institutionId, coOwner, "institution_owner");
  const operator = await plantOperator(tx, OPERATOR_ADDRESS);
  const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
  expect(removed.status).toBe(200);
  return { host, coOwner, workspace };
};

describe.skipIf(skipWithoutDatabase)(
  "what a host whose trust staff removed may grant in a workspace (rolled back)",
  () => {
    it.each(["institution_owner", "institution_staff"] as const)(
      "refuses a host whose trust staff removed an invitation as %s and writes no invitation",
      async (role) => {
        await inRollback(async (tx) => {
          const { host, workspace } = await hostWithWorkspaceAfterTrustRemoval(tx);
          await signUpHost(tx, THIRD_HOST_ADDRESS);

          const invited = await inviteThroughRoute(tx, host, workspace.slug, {
            invitedIdentifier: THIRD_HOST_ADDRESS,
            invitedRole: role,
          });

          expect(invited.status).toBe(403);
          expect(invited.body.error?.code).toBe(INVITATION_REFUSAL_CODE);
          expect(await invitedRolesOf(tx, workspace.institutionId)).toEqual([]);
        });
      },
    );

    it("lets a host whose trust staff removed invite a member", async () => {
      await inRollback(async (tx) => {
        const { host, workspace } = await hostWithWorkspaceAfterTrustRemoval(tx);
        await signUpHost(tx, THIRD_HOST_ADDRESS);

        const invited = await inviteThroughRoute(tx, host, workspace.slug, {
          invitedIdentifier: THIRD_HOST_ADDRESS,
          invitedRole: "institution_member",
        });

        expect(invited.status).toBe(201);
        expect(await invitedRolesOf(tx, workspace.institutionId)).toEqual(["institution_member"]);
      });
    });

    it.each(["institution_owner", "institution_staff"] as const)(
      "refuses a host whose trust staff removed the promotion of a member to %s and keeps the role",
      async (role) => {
        await inRollback(async (tx) => {
          const { host, workspace } = await hostWithWorkspaceAfterTrustRemoval(tx);
          const target = await signUpHost(tx, THIRD_HOST_ADDRESS);
          await plantMembership(tx, workspace.institutionId, target, "institution_member");
          const membership = await membershipOf(tx, workspace.institutionId, target);

          const promoted = await roleThroughRoute(tx, host, workspace.slug, membership.id, {
            role,
          });

          expect(promoted.status).toBe(403);
          expect(promoted.body.error?.code).toBe(ROLE_REFUSAL_CODE);
          expect((await membershipOf(tx, workspace.institutionId, target)).membershipRole).toBe(
            "institution_member",
          );
        });
      },
    );

    it("lets a host whose trust staff removed move a staff member to member", async () => {
      await inRollback(async (tx) => {
        const { host, workspace } = await hostWithWorkspaceAfterTrustRemoval(tx);
        const target = await signUpHost(tx, THIRD_HOST_ADDRESS);
        await plantMembership(tx, workspace.institutionId, target, "institution_staff");
        const membership = await membershipOf(tx, workspace.institutionId, target);

        const moved = await roleThroughRoute(tx, host, workspace.slug, membership.id, {
          role: "institution_member",
        });

        expect(moved.status).toBe(200);
        expect((await membershipOf(tx, workspace.institutionId, target)).membershipRole).toBe(
          "institution_member",
        );
      });
    });

    it("lets an owner whose trust was not removed invite and promote to staff in a workspace whose other owner staff removed", async () => {
      await inRollback(async (tx) => {
        const { coOwner, workspace } = await coOwnedWorkspaceAfterTrustRemoval(tx);
        const target = await signUpHost(tx, THIRD_HOST_ADDRESS);
        await plantMembership(tx, workspace.institutionId, target, "institution_member");

        const invited = await inviteThroughRoute(tx, coOwner, workspace.slug, {
          invitedIdentifier: OTHER_ADDRESS,
          invitedRole: "institution_staff",
        });

        expect(invited.status).toBe(201);
        expect(await invitedRolesOf(tx, workspace.institutionId)).toEqual(["institution_staff"]);

        const membership = await membershipOf(tx, workspace.institutionId, target);
        const promoted = await roleThroughRoute(tx, coOwner, workspace.slug, membership.id, {
          role: "institution_staff",
        });

        expect(promoted.status).toBe(200);
        expect((await membershipOf(tx, workspace.institutionId, target)).membershipRole).toBe(
          "institution_staff",
        );
      });
    });

    it("lets an owner whose trust was not removed save the payment instructions of a workspace whose other owner staff removed", async () => {
      await inRollback(async (tx) => {
        const { host, coOwner, workspace } = await coOwnedWorkspaceAfterTrustRemoval(tx);

        const savedByCoOwner = await paymentInstructionsThroughRoute(
          tx,
          coOwner,
          workspace.slug,
          BANK_ACCOUNT,
        );

        expect(savedByCoOwner.status).toBe(200);
        expect(await instructionsOf(tx, workspace.institutionId)).toEqual({
          accountNumber: "1370012345678",
          qrisR2Key: null,
        });

        const refusedForHost = await paymentInstructionsThroughRoute(tx, host, workspace.slug, {
          ...BANK_ACCOUNT,
          accountNumber: "9990012345678",
        });

        expect(refusedForHost.status).toBe(403);
        expect(refusedForHost.body.error?.code).toBe(PAYMENT_REFUSAL_CODE);
        expect(await instructionsOf(tx, workspace.institutionId)).toEqual({
          accountNumber: "1370012345678",
          qrisR2Key: null,
        });
      });
    });

    it.each(["institution_owner", "institution_staff"] as const)(
      "refuses the accept of an invitation as %s whose inviter staff then removed, and keeps it pending",
      async (role) => {
        await inRollback(async (tx) => {
          const host = await signUpHost(tx, HOST_ADDRESS);
          const workspace = await fullWorkspace(tx, host);
          const invitee = await signUpHost(tx, THIRD_HOST_ADDRESS);
          const invited = await inviteThroughRoute(tx, host, workspace.slug, {
            invitedIdentifier: THIRD_HOST_ADDRESS,
            invitedRole: role,
          });
          expect(invited.status).toBe(201);
          const invitationId = invited.body.invitation!.id;
          const operator = await plantOperator(tx, OPERATOR_ADDRESS);
          const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
          expect(removed.status).toBe(200);

          await expect(
            acceptInstitutionInvitationForUser(invitationId, invitee, [...ACCEPTING_ROLES], tx),
          ).rejects.toMatchObject({ code: ACCEPT_REFUSAL_CODE, httpStatus: 403 });

          const invitation = await invitationOf(tx, invitationId);
          expect(invitation.status).toBe("pending");
          expect(invitation.acceptedAt).toBeNull();
          expect(await hasActiveMembership(tx, workspace.institutionId, invitee)).toBe(false);
        });
      },
    );

    it("lets a member invitation from a host whose trust staff then removed be taken", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, HOST_ADDRESS);
        const workspace = await fullWorkspace(tx, host);
        const invitee = await signUpHost(tx, THIRD_HOST_ADDRESS);
        const invited = await inviteThroughRoute(tx, host, workspace.slug, {
          invitedIdentifier: THIRD_HOST_ADDRESS,
          invitedRole: "institution_member",
        });
        expect(invited.status).toBe(201);
        const invitationId = invited.body.invitation!.id;
        const operator = await plantOperator(tx, OPERATOR_ADDRESS);
        const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
        expect(removed.status).toBe(200);

        await expect(
          acceptInstitutionInvitationForUser(invitationId, invitee, [...ACCEPTING_ROLES], tx),
        ).resolves.toBeUndefined();

        expect((await invitationOf(tx, invitationId)).acceptedAt).toBeInstanceOf(Date);
        expect((await membershipOf(tx, workspace.institutionId, invitee)).membershipRole).toBe(
          "institution_member",
        );
      });
    });

    it("lets an invitation as staff from an owner whose trust was not removed be taken in a workspace whose other owner staff removed", async () => {
      await inRollback(async (tx) => {
        const { coOwner, workspace } = await coOwnedWorkspaceAfterTrustRemoval(tx);
        const invitee = await signUpHost(tx, THIRD_HOST_ADDRESS);
        const invited = await inviteThroughRoute(tx, coOwner, workspace.slug, {
          invitedIdentifier: THIRD_HOST_ADDRESS,
          invitedRole: "institution_staff",
        });
        expect(invited.status).toBe(201);
        const invitationId = invited.body.invitation!.id;

        await expect(
          acceptInstitutionInvitationForUser(invitationId, invitee, [...ACCEPTING_ROLES], tx),
        ).resolves.toBeUndefined();

        expect((await invitationOf(tx, invitationId)).acceptedAt).toBeInstanceOf(Date);
        expect((await membershipOf(tx, workspace.institutionId, invitee)).membershipRole).toBe(
          "institution_staff",
        );
      });
    });

    it("refuses a host whose trust staff removed moving the other owner to staff and keeps the role", async () => {
      await inRollback(async (tx) => {
        const { host, coOwner, workspace } = await coOwnedWorkspaceAfterTrustRemoval(tx);
        const membership = await membershipOf(tx, workspace.institutionId, coOwner);

        const moved = await roleThroughRoute(tx, host, workspace.slug, membership.id, {
          role: "institution_staff",
        });

        expect(moved.status).toBe(403);
        expect(moved.body.error?.code).toBe(ROLE_REFUSAL_CODE);
        expect((await membershipOf(tx, workspace.institutionId, coOwner)).membershipRole).toBe(
          "institution_owner",
        );
      });
    });

    it("refuses a host whose trust staff removed moving a staff member to owner and keeps the role", async () => {
      await inRollback(async (tx) => {
        const { host, workspace } = await hostWithWorkspaceAfterTrustRemoval(tx);
        const target = await signUpHost(tx, THIRD_HOST_ADDRESS);
        await plantMembership(tx, workspace.institutionId, target, "institution_staff");
        const membership = await membershipOf(tx, workspace.institutionId, target);

        const moved = await roleThroughRoute(tx, host, workspace.slug, membership.id, {
          role: "institution_owner",
        });

        expect(moved.status).toBe(403);
        expect(moved.body.error?.code).toBe(ROLE_REFUSAL_CODE);
        expect((await membershipOf(tx, workspace.institutionId, target)).membershipRole).toBe(
          "institution_staff",
        );
      });
    });
  },
);
