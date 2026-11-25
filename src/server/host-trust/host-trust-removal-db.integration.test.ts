// @vitest-environment node

// The staff removal of a host's trust, against real rows in a rolled-back transaction. Hosts come
// through the real sign-up and host step services, removals through the real removal route or the
// removal service, presses through the real publish route, the Email organisasi through its real
// code services and the legacy approval through its real service. A row is planted directly only
// where this file does not drive its writer, and each such helper says so.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, eq } from "drizzle-orm";
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
    enqueueCompetitionCancelled: vi.fn(async () => ({})),
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

// De-identification refuses to run without storage, and it and the legacy approval list stored
// objects. The store answers with none, so no test here reaches it.
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
import { createPersonalInstitutionForUser } from "@/server/institution-workspace/institution-service";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { removeHostTrust } from "./host-trust-removal-service";
import { deidentifyAccount } from "@/server/accounts/account-deidentification-service";
import {
  reviewRecruiterVerification,
  submitRecruiterVerification,
} from "@/server/recruiter-verification/recruiter-verification-service";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
import { POST as removalRoute } from "@/app/api/platform-ops/accounts/[accountId]/host-trust-removal/route";
import {
  processHostTrustRemovedJob,
  type HostTrustRemovedJob,
} from "@/server/async/jobs/host-trust-removed";
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
  mocks.enqueueRemoved.mockClear();
  mocks.enqueueApproved.mockClear();
  mocks.sendRemovedEmail.mockClear();
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

  it("clears a trust removal when staff approve a request through the legacy approval", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, HOST_ADDRESS);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const removed = await removeThroughRoute(tx, operator, host, { reason: REASON });
      expect(removed.status).toBe(200);
      const submitted = await submitRecruiterVerification(
        host,
        { fullName: "Budi Santoso", mobileNumber: "081298765432", corporateEmail: null },
        tx,
      );

      await reviewRecruiterVerification(operator, submitted.id, "approve", null, { db: tx });

      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await trustRemovedAtOf(tx, host)).toBeNull();
    });
  });
});
