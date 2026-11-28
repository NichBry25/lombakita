// @vitest-environment node

// The 28-day name proof against real rows: the reminder, the removal on day 29, and what holds or
// stops it. Accounts come through the real sign-up, code verification and host step services, the
// Email organisasi through its real code services, workspaces and invitations through their
// services, requests and owner actions through the real route handlers with the Rule 16 header, and
// decisions through the real decision services. The queue is a fake that records what the real
// enqueue helpers send, so the job ids are the ones production builds. A row is planted directly only
// where no production path reaches it, and each such place says so.
//
// Every sweep takes the `now` the test passes. A due date at a set distance from that `now` is set by
// an UPDATE to a whole-millisecond value, because a 28-day wait has no production path in a test.
// The sweep reads every row of the database, so every assertion on enqueues, inbox rows and audit
// rows counts only the rows of the test's own workspaces.
//
// The last describe COMMITS, because one connection cannot wait on itself: a second connection holds
// a row lock the sweep is expected to wait on. Every committed row is deleted by id in a finally, and
// what survived is asserted.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

type QueueAdd = {
  name: string;
  data: Record<string, unknown>;
  opts: { jobId: string };
};

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

// The fake queue answers "no such job" and records the three arguments of every add. A test can make
// the next add fail, or hold every add until a number of reminders have arrived.
const queueState = vi.hoisted(() => ({
  adds: [] as QueueAdd[],
  rejectNextAdd: false,
  holdUntilReminders: null as number | null,
  holdDeadlineMs: 5_000,
}));

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const emailSpy = vi.hoisted(() => vi.fn(async () => {}));

const failures = vi.hoisted(() => ({ removalFor: null as string | null }));

vi.mock("@/lib/logger", () => ({ logger: loggerSpies }));

vi.mock("@/server/async/queue", () => {
  const isReminder = (add: QueueAdd): boolean => add.data.kind === "name_proof_reminder";
  const queue = {
    getJob: async () => null,
    add: async (name: string, data: Record<string, unknown>, opts: { jobId: string }) => {
      queueState.adds.push({ name, data, opts });
      if (queueState.rejectNextAdd) {
        queueState.rejectNextAdd = false;
        throw new Error("redis down");
      }
      if (queueState.holdUntilReminders !== null) {
        const deadline = Date.now() + queueState.holdDeadlineMs;
        while (
          queueState.adds.filter(isReminder).length < queueState.holdUntilReminders &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return { id: opts.jobId };
    },
  };
  return { getAsyncQueue: () => queue };
});

vi.mock("@/server/institution-verification/tick-transition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tick-transition")>();
  return {
    ...actual,
    removeTickAutomatically: async (
      ...args: Parameters<typeof actual.removeTickAutomatically>
    ): Promise<Awaited<ReturnType<typeof actual.removeTickAutomatically>>> => {
      if (args[1].institutionId === failures.removalFor) throw new Error("removal write failed");
      return actual.removeTickAutomatically(...args);
    },
  };
});

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

vi.mock("@/server/notifications/notification-email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications/notification-email")>();
  return { ...actual, sendInstitutionTickNoticeEmail: emailSpy };
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
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  acceptInstitutionInvitationForUser,
  createInstitutionInvitation,
} from "@/server/institution-invitations/invitation-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { processInstitutionTickNoticeJob } from "@/server/async/jobs/institution-tick-notice";
import type { InstitutionTickNoticeJob } from "@/server/async/jobs/institution-tick-notice";
import {
  decideNameCheck,
  listTickQueue,
  sweepNameProofs,
  type NameProofSweepResult,
} from "./name-check-service";
import { reviewVerificationSubmission } from "./submission-service";
import { tickByOrganizationDomain } from "./tick-service";
import { TICK_REMOVED_NAME_PROOF } from "./tick-transition";
import { verifyInstitution } from "./verification-service";
import { POST as domainRoute } from "@/app/api/v1/institutions/[institutionSlug]/tick/domain/route";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const PROOF_REASON = "Kirim akta pendirian dan surat keputusan pengurus.";
const PATH_B_CLOSED_BY_REMOVAL_NOTE =
  "Ditutup karena centang ruang kerja dicabut otomatis. Centang hanya dapat didapat lagi lewat dokumen.";
const NOTICE_JOB_NAME = "institution.tick.notice";

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
  queueState.adds.length = 0;
  queueState.rejectNextAdd = false;
  queueState.holdUntilReminders = null;
  failures.removalFor = null;
  emailSpy.mockClear();
  for (const spy of Object.values(loggerSpies)) spy.mockClear();
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

// Signs in under .local, which no trust source accepts, so trust comes from the Email organisasi.
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
      email: `ops_sweep_${suffix}@example.test`,
      username: `ops_sweep_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No staff row");
  return row.id;
};

type Owner = { institutionId: string; slug: string; ownerId: string };

// The owner signed up and took the host step, confirmed an Email organisasi (which trusts the
// account), created the workspace and saved its website.
const buildUntickedOwner = async (tx: Database): Promise<Owner> => {
  const ownerId = await signUpHost(tx, "pemilik");
  await confirmOrganizationEmail(tx, ownerId, `budi.${freshPart()}@students.acme.example`);
  const workspace = await createInstitutionWorkspaceForUser(
    ownerId,
    { displayName: `Ruang Kerja ${freshPart()}`, institutionType: "company" },
    tx,
  );
  await updateInstitutionProfileForOwnerBySlug(
    ownerId,
    workspace.slug,
    { websiteUrl: "https://www.acme.example" },
    tx,
  );
  return { institutionId: workspace.institutionId, slug: workspace.slug, ownerId };
};

// A Path A tick: the workspace ticked through tickByOrganizationDomain.
const buildPathATick = async (tx: Database): Promise<Owner> => {
  const owner = await buildUntickedOwner(tx);
  await tickByOrganizationDomain(owner.ownerId, owner.slug, tx);
  return owner;
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

// A proof as staff start it: a platform_ops account asks for proof of the name.
const startNameProof = async (
  tx: Database,
  staffId: string,
  institutionId: string,
): Promise<void> => {
  await decideNameCheck(
    staffId,
    institutionId,
    { decision: "require_proof", reason: PROOF_REASON },
    tx,
  );
};

// A free draft that passes the publish checklist.
const createFreeDraft = async (tx: Database, owner: Owner, title: string): Promise<string> => {
  const now = Date.now();
  const draft = await createCompetitionDraft(
    owner.ownerId,
    {
      institutionSlug: owner.slug,
      title,
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
  return draft.id;
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
) => Promise<Response>;

type RouteAnswer = {
  status: number;
  body: {
    error?: { code: string; details?: { cause?: string } };
    submissionId?: string;
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

const pressPublish = async (
  tx: Database,
  owner: Owner,
  competitionId: string,
): Promise<{ status: number }> => {
  routeState.transaction = tx;
  routeState.actorUserId = owner.ownerId;
  const response = await publishRoute(
    new Request(
      `http://localhost/api/v1/institutions/${owner.slug}/competitions/${competitionId}/publish`,
      { method: "POST", headers: { [SESSION_USER_HEADER]: owner.ownerId } },
    ),
    { params: Promise.resolve({ institutionSlug: owner.slug, competitionId }) },
  );
  return { status: response.status };
};

const COMPANY_DOCUMENTS = ["npwp", "nib"].map((documentType) => ({
  documentType,
  originalFileName: `${documentType}.pdf`,
  fileSizeBytes: 1024,
  contentType: "application/pdf",
}));

const INSTAGRAM_REQUEST = { path: "instagram", instagramUrl: "https://instagram.com/acme.org" };

const submitDocuments = async (tx: Database, owner: Owner): Promise<string> => {
  const answer = await callRoute(tx, submitRoute, owner.ownerId, owner.slug, "POST", {
    documents: COMPANY_DOCUMENTS,
  });
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const submitInstagram = async (tx: Database, owner: Owner): Promise<string> => {
  const answer = await callRoute(
    tx,
    submitRoute,
    owner.ownerId,
    owner.slug,
    "POST",
    INSTAGRAM_REQUEST,
  );
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const approve = (tx: Database, staffId: string, submissionId: string) =>
  reviewVerificationSubmission(submissionId, "approved", null, staffId, tx);

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

const storedStatusOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({ status: schema.competitions.status })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.status;
};

const inboxRowsOf = (tx: Database, userIds: string[]) =>
  tx
    .select({
      userId: schema.notifications.userId,
      title: schema.notifications.title,
      body: schema.notifications.body,
    })
    .from(schema.notifications)
    .where(inArray(schema.notifications.userId, userIds));

// The due date as the exact UTC text the notice carries.
const dueTextOf = async (tx: Database, institutionId: string): Promise<string> => {
  const rows = await tx.execute<{ due: string }>(sql`
    select to_char(name_proof_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due
    from institutions where id = ${institutionId}`);
  return rows[0]!.due;
};

// Planted directly: a 28-day wait has no production path in a test, so the due date is set to a
// whole-millisecond value computed from the test's `now`.
const setDueDate = async (tx: Database, institutionId: string, due: Date): Promise<void> => {
  await tx
    .update(schema.institutions)
    .set({ nameProofDueAt: due })
    .where(eq(schema.institutions.id, institutionId));
};

const dueDateAfter = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const secondsOf = (due: Date): number => Math.floor(due.getTime() / 1000);

const isReminder = (add: QueueAdd): boolean => add.data.kind === "name_proof_reminder";

const addsOf = (institutionId: string, kind: string): QueueAdd[] =>
  queueState.adds.filter(
    (add) =>
      add.name === NOTICE_JOB_NAME &&
      add.data.institutionId === institutionId &&
      add.data.kind === kind,
  );

const reminderJobId = (institutionId: string, due: Date): string =>
  `${NOTICE_JOB_NAME}__name-proof-reminder-${institutionId}-${secondsOf(due)}`;

const removalJobId = (institutionId: string, due: Date): string =>
  `${NOTICE_JOB_NAME}__name-proof-removed-${institutionId}-${secondsOf(due)}`;

const errorLogsNamed = (message: string) =>
  loggerSpies.error.mock.calls.filter(([logged]) => logged === message);

const noticeJobOf = (data: Record<string, unknown>): InstitutionTickNoticeJob =>
  ({
    id: "job_notice",
    data,
    updateData: async () => undefined,
  }) as unknown as InstitutionTickNoticeJob;

const fiveTickColumnsOf = (row: Awaited<ReturnType<typeof readWorkspace>>) => [
  row.tickPath,
  row.tickDomain,
  row.nameCheckedAt,
  row.nameProofDueAt,
  row.nameProofRemindedAt,
];

// A Path A tick whose name proof runs until `due`.
const buildProofUntil = async (
  tx: Database,
  due: Date,
): Promise<{ owner: Owner; staffId: string }> => {
  const owner = await buildPathATick(tx);
  const staffId = await seedStaff(tx);
  await startNameProof(tx, staffId, owner.institutionId);
  await setDueDate(tx, owner.institutionId, due);
  return { owner, staffId };
};

describe.skipIf(skipWithoutDatabase)("the name proof sweep (real database)", () => {
  it("the reminder goes once, 7 days before the end", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const { owner } = await buildProofUntil(tx, due);

      await sweepNameProofs(new Date(due.getTime() - 7 * DAY_MS - MINUTE_MS), tx);

      expect(addsOf(owner.institutionId, "name_proof_reminder")).toEqual([]);
      expect((await readWorkspace(tx, owner.institutionId)).nameProofRemindedAt).toBeNull();

      const result = await sweepNameProofs(new Date(due.getTime() - 7 * DAY_MS), tx);

      const reminders = addsOf(owner.institutionId, "name_proof_reminder");
      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.opts.jobId).toBe(reminderJobId(owner.institutionId, due));
      expect(reminders[0]?.data.dueAt).toBe(await dueTextOf(tx, owner.institutionId));
      expect(result.reminded).toContain(owner.institutionId);
      expect((await readWorkspace(tx, owner.institutionId)).nameProofRemindedAt).not.toBeNull();

      await sweepNameProofs(new Date(due.getTime() - 7 * DAY_MS), tx);

      expect(addsOf(owner.institutionId, "name_proof_reminder")).toHaveLength(1);

      // Two sweeps started together, each held at the queue until both reminders have arrived.
      const raced = await buildProofUntil(tx, due);
      queueState.holdUntilReminders = queueState.adds.filter(isReminder).length + 2;
      const [first, second] = await Promise.all([
        sweepNameProofs(new Date(due.getTime() - 7 * DAY_MS), tx),
        sweepNameProofs(new Date(due.getTime() - 7 * DAY_MS), tx),
      ]);
      queueState.holdUntilReminders = null;

      const racedReminders = addsOf(raced.owner.institutionId, "name_proof_reminder");
      expect(racedReminders).toHaveLength(2);
      expect(racedReminders[0]?.opts.jobId).toBe(racedReminders[1]?.opts.jobId);
      const winners = [first, second].filter((result) =>
        result.reminded.includes(raced.owner.institutionId),
      );
      expect(winners).toHaveLength(1);
    });
  });

  it("a failed reminder enqueue is tried again", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const { owner } = await buildProofUntil(tx, due);
      const reminderNow = new Date(due.getTime() - 7 * DAY_MS);
      queueState.rejectNextAdd = true;

      const first = await sweepNameProofs(reminderNow, tx);

      expect((await readWorkspace(tx, owner.institutionId)).nameProofRemindedAt).toBeNull();
      const logged = errorLogsNamed("name_proof.reminder_enqueue_failed");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.[1]).toMatchObject({ institutionId: owner.institutionId });
      expect(first.reminderEnqueueFailed).toContain(owner.institutionId);

      queueState.adds.length = 0;
      await sweepNameProofs(reminderNow, tx);

      expect(addsOf(owner.institutionId, "name_proof_reminder")).toHaveLength(1);
      expect((await readWorkspace(tx, owner.institutionId)).nameProofRemindedAt).not.toBeNull();
    });
  });

  it("one failed reminder mark does not stop the sweep", async () => {
    await inRollback(async (tx) => {
      const dueA = dueDateAfter(20);
      const runOut = await buildProofUntil(tx, dueA);
      await sweepNameProofs(new Date(dueA.getTime() - 7 * DAY_MS), tx);
      expect(
        (await readWorkspace(tx, runOut.owner.institutionId)).nameProofRemindedAt,
      ).not.toBeNull();
      const dueB = dueDateAfter(25);
      const first = await buildProofUntil(tx, dueB);
      const second = await buildProofUntil(tx, dueB);
      // Planted: the first write of the sweep fails before any statement reaches the database, so
      // the rolled-back transaction stays usable.
      const update = vi.spyOn(tx, "update").mockImplementationOnce(() => {
        throw new Error("reminder mark failed");
      });

      const outcome = await sweepNameProofs(dueA, tx).then(
        (value) => value,
        (error: unknown) => error,
      );
      update.mockRestore();

      expect((await readWorkspace(tx, runOut.owner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
      const firstMarked =
        (await readWorkspace(tx, first.owner.institutionId)).nameProofRemindedAt !== null;
      const secondMarked =
        (await readWorkspace(tx, second.owner.institutionId)).nameProofRemindedAt !== null;
      expect([firstMarked, secondMarked].sort()).toEqual([false, true]);
      const markedId = firstMarked ? first.owner.institutionId : second.owner.institutionId;
      const failedId = firstMarked ? second.owner.institutionId : first.owner.institutionId;
      expect(addsOf(first.owner.institutionId, "name_proof_reminder")).toHaveLength(1);
      expect(addsOf(second.owner.institutionId, "name_proof_reminder")).toHaveLength(1);
      expect(outcome).not.toBeInstanceOf(Error);
      const result = outcome as NameProofSweepResult;
      expect(result.reminded).toContain(markedId);
      expect(result.reminded).not.toContain(failedId);
      expect(result.removed).toContain(runOut.owner.institutionId);
      const logged = errorLogsNamed("name_proof.reminder_mark_failed");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.[1]).toMatchObject({
        institutionId: failedId,
        error: "reminder mark failed",
      });
    });
  });

  it("a due date stored with microseconds is reminded and removed", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      await startNameProof(tx, staffId, owner.institutionId);
      await tx.execute(sql`
        update institutions
        set name_proof_due_at = ${due.toISOString()}::timestamptz + interval '123 microseconds'
        where id = ${owner.institutionId}`);
      const stored = await tx.execute<{ remainder: number }>(sql`
        select (extract(microseconds from name_proof_due_at))::bigint % 1000 as remainder
        from institutions where id = ${owner.institutionId}`);
      expect(Number(stored[0]!.remainder)).toBe(123);
      const dueText = await dueTextOf(tx, owner.institutionId);

      await sweepNameProofs(new Date(due.getTime() - 6 * DAY_MS), tx);

      const reminders = addsOf(owner.institutionId, "name_proof_reminder");
      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.data.dueAt).toBe(dueText);
      expect(String(reminders[0]?.data.dueAt)).toMatch(/\.\d{3}123Z$/);
      expect((await readWorkspace(tx, owner.institutionId)).nameProofRemindedAt).not.toBeNull();

      routeState.transaction = tx;
      await processInstitutionTickNoticeJob(noticeJobOf(reminders[0]!.data));
      expect(await inboxRowsOf(tx, [owner.ownerId])).toHaveLength(1);

      await sweepNameProofs(new Date(due.getTime() + MINUTE_MS), tx);

      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.verificationStatus).toBe("pending_verification");
      const removals = (await auditRowsOf(tx, owner.institutionId)).filter(
        (auditRow) => auditRow.reason === TICK_REMOVED_NAME_PROOF,
      );
      expect(removals).toHaveLength(1);
    });
  });

  it("on day 29 the tick goes by itself", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      const freeDraftId = await createFreeDraft(tx, owner, "Lomba Gratis");
      expect((await pressPublish(tx, owner, freeDraftId)).status).toBe(200);
      await startNameProof(tx, staffId, owner.institutionId);
      await setDueDate(tx, owner.institutionId, due);
      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;

      await sweepNameProofs(new Date(due.getTime() - MINUTE_MS), tx);

      expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe("verified");

      await sweepNameProofs(due, tx);

      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.verificationStatus).toBe("pending_verification");
      expect(fiveTickColumnsOf(row)).toEqual([null, null, null, null, null]);
      const audit = await auditRowsOf(tx, owner.institutionId);
      expect(audit).toHaveLength(auditBefore + 1);
      expect(audit.at(-1)).toEqual({
        fromStatus: "verified",
        toStatus: "pending_verification",
        reason: "Bukti nama tidak dikirim dalam 28 hari.",
        actorUserId: null,
      });
      const removals = addsOf(owner.institutionId, "tick_removed_name_proof");
      expect(removals).toHaveLength(1);
      expect(removals[0]?.opts.jobId).toBe(removalJobId(owner.institutionId, due));
      expect(await storedStatusOf(tx, freeDraftId)).toBe("published");
    });
  });

  it("a proof sent before the end holds the removal until staff decide", async () => {
    await inRollback(async (tx) => {
      // A Path C request submitted before the due time holds the removal until staff turn it down.
      const due = dueDateAfter(20);
      const { owner, staffId } = await buildProofUntil(tx, due);
      const requestId = await submitDocuments(tx, owner);

      await sweepNameProofs(new Date(due.getTime() + MINUTE_MS), tx);

      const held = await readWorkspace(tx, owner.institutionId);
      expect(held.verificationStatus).toBe("verified");
      expect(held.tickPath).toBe("domain");

      await reviewVerificationSubmission(
        requestId,
        "rejected",
        "Dokumen belum lengkap.",
        staffId,
        tx,
      );
      await sweepNameProofs(new Date(due.getTime() + 2 * MINUTE_MS), tx);

      expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );

      // A Path C request submitted after the due time does not hold it.
      const late = await buildPathATick(tx);
      await startNameProof(tx, staffId, late.institutionId);
      await tx.execute(sql`
        update institutions set name_proof_due_at = now() - interval '1 hour'
        where id = ${late.institutionId}`);
      await submitDocuments(tx, late);

      await sweepNameProofs(new Date(Date.now() + MINUTE_MS), tx);

      expect((await readWorkspace(tx, late.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );

      // A Path B request never holds it. The proof is planted after the submit, because a staff
      // request for proof would close that request.
      const instagramDue = dueDateAfter(20);
      const instagramOwner = await buildPathATick(tx);
      await submitInstagram(tx, instagramOwner);
      await setDueDate(tx, instagramOwner.institutionId, instagramDue);

      await sweepNameProofs(new Date(instagramDue.getTime() + MINUTE_MS), tx);

      expect((await readWorkspace(tx, instagramOwner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
    });
  });

  it("a complaint lets staff remove at once", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const { owner, staffId } = await buildProofUntil(tx, due);
      const reason = "Pengaduan dari institusi resmi.";

      await verifyInstitution({
        institutionId: owner.institutionId,
        targetStatus: "rejected",
        reason,
        actorUserId: staffId,
        db: tx,
      });

      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.verificationStatus).toBe("rejected");
      expect(fiveTickColumnsOf(row)).toEqual([null, null, null, null, null]);
      const revoked = addsOf(owner.institutionId, "tick_revoked");
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.data.reason).toBe(reason);
      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;

      await sweepNameProofs(new Date(due.getTime() + MINUTE_MS), tx);

      expect(addsOf(owner.institutionId, "tick_removed_name_proof")).toEqual([]);
      expect(await auditRowsOf(tx, owner.institutionId)).toHaveLength(auditBefore);
    });
  });

  it("Path A stays closed after the day-29 removal", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const { owner, staffId } = await buildProofUntil(tx, due);
      await sweepNameProofs(due, tx);
      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;

      const pressed = await callRoute(tx, domainRoute, owner.ownerId, owner.slug, "POST");

      expect(pressed.status).toBe(409);
      expect(pressed.body.error?.code).toBe("institution_tick_path_a_closed");
      expect(pressed.body.error?.details?.cause).toBe("automatic");
      expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
      expect(await auditRowsOf(tx, owner.institutionId)).toHaveLength(auditBefore);

      await approve(tx, staffId, await submitDocuments(tx, owner));

      const restored = await readWorkspace(tx, owner.institutionId);
      expect(restored.verificationStatus).toBe("verified");
      expect(restored.tickPath).toBe("documents");
    });
  });

  it("a document approval after the day-29 removal opens Path A on the owner's other workspace", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const { owner, staffId } = await buildProofUntil(tx, due);
      await sweepNameProofs(due, tx);
      expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
      const created = await createInstitutionWorkspaceForUser(
        owner.ownerId,
        { displayName: `Ruang Kerja ${freshPart()}`, institutionType: "company" },
        tx,
      );
      await updateInstitutionProfileForOwnerBySlug(
        owner.ownerId,
        created.slug,
        { websiteUrl: "https://www.acme.example" },
        tx,
      );
      const sibling: Owner = {
        institutionId: created.institutionId,
        slug: created.slug,
        ownerId: owner.ownerId,
      };
      const requestId = await submitInstagram(tx, sibling);

      const closedQueue = await listTickQueue(tx);
      const closedRequest = closedQueue.requests.find(
        (request) => request.submissionId === requestId,
      );
      expect(closedRequest?.siblingClosures).toEqual([
        { cause: "automatic", closedInstitutionId: owner.institutionId },
      ]);
      const closedPress = await callRoute(tx, domainRoute, owner.ownerId, sibling.slug, "POST");
      expect(closedPress.status).toBe(409);
      expect(closedPress.body.error?.code).toBe("institution_tick_path_a_closed");
      expect(closedPress.body.error?.details?.cause).toBe("automatic");

      await approve(tx, staffId, await submitDocuments(tx, owner));
      const restored = await readWorkspace(tx, owner.institutionId);
      expect(restored.verificationStatus).toBe("verified");
      expect(restored.tickPath).toBe("documents");

      const openQueue = await listTickQueue(tx);
      const openRequest = openQueue.requests.find((request) => request.submissionId === requestId);
      const pressed = await callRoute(tx, domainRoute, owner.ownerId, sibling.slug, "POST");

      expect(openRequest?.siblingClosures).toEqual([]);
      expect(pressed.status).toBe(200);
      const ticked = await readWorkspace(tx, sibling.institutionId);
      expect(ticked.verificationStatus).toBe("verified");
      expect(ticked.tickPath).toBe("domain");
    });
  });

  it("the day-29 removal closes a pending Path B request and only Path C restores", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(20);
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      await submitInstagram(tx, owner);
      // Planted directly: a staff request for proof would close the pending request first.
      await setDueDate(tx, owner.institutionId, due);

      await sweepNameProofs(new Date(due.getTime() + MINUTE_MS), tx);

      const [request] = await submissionRowsOf(tx, owner.institutionId);
      expect(request).toMatchObject({
        status: "rejected",
        reviewerUserId: null,
        reviewerNotes: PATH_B_CLOSED_BY_REMOVAL_NOTE,
      });
      expect(request?.reviewedAt).not.toBeNull();

      const again = await callRoute(
        tx,
        submitRoute,
        owner.ownerId,
        owner.slug,
        "POST",
        INSTAGRAM_REQUEST,
      );
      expect(again.status).toBe(409);
      expect(again.body.error?.code).toBe("institution_tick_closed_needs_documents");
      expect(await submissionRowsOf(tx, owner.institutionId)).toHaveLength(1);

      await approve(tx, staffId, await submitDocuments(tx, owner));

      const restored = await readWorkspace(tx, owner.institutionId);
      expect(restored.verificationStatus).toBe("verified");
      expect(restored.tickPath).toBe("documents");
    });
  });

  it("a reminder whose proof ended is not sent", async () => {
    await inRollback(async (tx) => {
      routeState.transaction = tx;
      const due = dueDateAfter(20);
      const reminderNow = new Date(due.getTime() - 7 * DAY_MS);
      const { owner, staffId } = await buildProofUntil(tx, due);
      await sweepNameProofs(reminderNow, tx);
      const kept = addsOf(owner.institutionId, "name_proof_reminder");
      expect(kept).toHaveLength(1);

      await approve(tx, staffId, await submitDocuments(tx, owner));
      emailSpy.mockClear();
      loggerSpies.warn.mockClear();
      routeState.transaction = tx;
      await processInstitutionTickNoticeJob(noticeJobOf(kept[0]!.data));

      expect(await inboxRowsOf(tx, [owner.ownerId])).toEqual([]);
      expect(emailSpy).not.toHaveBeenCalled();
      const skipped = loggerSpies.warn.mock.calls.filter(
        ([message]) => message === "institution_tick.notice_skipped",
      );
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.[1]).toMatchObject({
        institutionId: owner.institutionId,
        reason: "name_proof_ended",
      });

      // With the proof still running, the same data written by its own sweep reaches every owner.
      const running = await buildProofUntil(tx, due);
      const coOwner = await addCoOwner(tx, running.owner);
      queueState.adds.length = 0;
      await sweepNameProofs(reminderNow, tx);
      const sent = addsOf(running.owner.institutionId, "name_proof_reminder");
      expect(sent).toHaveLength(1);
      emailSpy.mockClear();

      await processInstitutionTickNoticeJob(noticeJobOf(sent[0]!.data));

      const inbox = await inboxRowsOf(tx, [running.owner.ownerId, coOwner]);
      expect(inbox).toHaveLength(2);
      for (const row of inbox) expect(row.title).toBe("Sisa 7 hari untuk bukti nama");
      expect(emailSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("one failed removal does not stop the sweep", async () => {
    await inRollback(async (tx) => {
      const staffId = await seedStaff(tx);
      const first = await buildPathATick(tx);
      const second = await buildPathATick(tx);
      for (const owner of [first, second]) {
        await startNameProof(tx, staffId, owner.institutionId);
        await tx.execute(sql`
          update institutions set name_proof_due_at = now() - interval '1 hour'
          where id = ${owner.institutionId}`);
      }
      failures.removalFor = first.institutionId;

      const result = await sweepNameProofs(new Date(), tx);

      expect((await readWorkspace(tx, second.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
      expect((await readWorkspace(tx, first.institutionId)).verificationStatus).toBe("verified");
      const logged = errorLogsNamed("name_proof.removal_failed");
      expect(logged.map(([, meta]) => (meta as { institutionId: string }).institutionId)).toEqual([
        first.institutionId,
      ]);
      expect(result.removed).toContain(second.institutionId);
      expect(result.removalFailed).toContain(first.institutionId);
    });
  });

  it("a slug change during a proof keeps it, and day 29 still removes", async () => {
    await inRollback(async (tx) => {
      const due = dueDateAfter(23);
      const { owner } = await buildProofUntil(tx, due);
      const before = await readWorkspace(tx, owner.institutionId);

      const answer = await callRoute(tx, settingsRoute, owner.ownerId, owner.slug, "PATCH", {
        slug: `alamat-baru-${freshPart()}`,
      });

      expect(answer.status).toBe(200);
      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.verificationStatus).toBe("verified");
      expect(row.tickPath).toBe("domain");
      expect(row.nameProofDueAt).toEqual(before.nameProofDueAt);
      expect(row.nameProofRemindedAt).toEqual(before.nameProofRemindedAt);
      expect(row.nameCheckedAt).toBeNull();

      await sweepNameProofs(due, tx);

      expect((await readWorkspace(tx, owner.institutionId)).verificationStatus).toBe(
        "pending_verification",
      );
      expect((await auditRowsOf(tx, owner.institutionId)).at(-1)?.reason).toBe(
        TICK_REMOVED_NAME_PROOF,
      );
    });
  });
});

// ── Committed rows: a lock the sweep must wait on ────────────────────────────────────────────

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

// A `now` in a past year, so this run selects only this harness's rows: the sweep reads every
// workspace of the database, and no other row has a proof that ended in 2020.
const FIXED_NOW = new Date("2020-01-10T00:00:00.000Z");
const FIXED_DUE = new Date("2020-01-05T00:00:00.000Z");
const FIXED_REMINDED = new Date("2020-01-04T00:00:00.000Z");

describe.skipIf(skipWithoutDatabase)(
  "an approval that lands between the sweep's read and its write (committed rows)",
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

    // The proof ended in 2020 and its reminder is marked as sent, so the reminder phase skips the
    // row and the first write of the sweep that waits is the removal.
    const endProofInThePast = async (institutionId: string): Promise<void> => {
      await control.db
        .update(schema.institutions)
        .set({ nameProofDueAt: FIXED_DUE, nameProofRemindedAt: FIXED_REMINDED })
        .where(eq(schema.institutions.id, institutionId));
    };

    it("an approval that lands between the sweep's read and its write keeps the tick", async () => {
      try {
        const database = asDatabase(control);

        // Case 1: a Path C approval commits under the sweep.
        const owner = await seedCommittedPathATick();
        const staffId = await seedCommittedStaff();
        await startNameProof(database, staffId, owner.institutionId);
        await endProofInThePast(owner.institutionId);
        const requestId = await submitDocuments(database, owner);
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);

        const approved = await holdTransactionWhile(
          holder,
          (tx) => reviewVerificationSubmission(requestId, "approved", null, staffId, tx),
          async () => {
            const running = settle(sweepNameProofs(FIXED_NOW, asDatabase(racer)));
            await awaitBlockedBy(control, racerPid, holderPid, "the removal");
            return { racer: running };
          },
        );

        expect(approved.ok).toBe(true);
        const kept = await readWorkspace(database, owner.institutionId);
        expect(kept.verificationStatus).toBe("verified");
        expect(kept.tickPath).toBe("documents");
        expect(
          (await auditRowsOf(database, owner.institutionId)).filter(
            (row) => row.reason === TICK_REMOVED_NAME_PROOF,
          ),
        ).toEqual([]);
        expect(addsOf(owner.institutionId, "tick_removed_name_proof")).toEqual([]);

        // Case 2: a name decision with a reason commits under the sweep, and the workspace holds a
        // pending Path B request that the race of "a Path B approval is refused after a closure"
        // leaves open under a running proof.
        const pathB = await seedCommittedPathATick();
        const pathBStaff = await seedCommittedStaff();
        const filed = await holdTransactionWhile(
          holder,
          (tx) =>
            decideNameCheck(
              pathBStaff,
              pathB.institutionId,
              { decision: "require_proof", reason: PROOF_REASON },
              tx,
            ),
          async () => {
            const submitted = await mustNotWait(
              callRoute(
                asDatabase(racer),
                submitRoute,
                pathB.ownerId,
                pathB.slug,
                "POST",
                INSTAGRAM_REQUEST,
              ),
              "the Path B submit",
            );
            return { racer: Promise.resolve({ ok: true as const, value: submitted }) };
          },
        );
        expect(filed.ok && filed.value.status).toBe(201);
        await endProofInThePast(pathB.institutionId);

        const decided = await holdTransactionWhile(
          holder,
          (tx) =>
            decideNameCheck(
              pathBStaff,
              pathB.institutionId,
              { decision: "name_ok", reason: "Dokumen nama sudah diperiksa." },
              tx,
            ),
          async () => {
            const running = settle(sweepNameProofs(FIXED_NOW, asDatabase(racer)));
            await awaitBlockedBy(control, racerPid, holderPid, "the removal");
            return { racer: running };
          },
        );

        expect(decided.ok).toBe(true);
        const checked = await readWorkspace(database, pathB.institutionId);
        expect(checked.verificationStatus).toBe("verified");
        expect(checked.tickPath).toBe("domain");
        expect(checked.nameCheckedAt).not.toBeNull();
        const [pending] = await submissionRowsOf(database, pathB.institutionId);
        expect(pending).toMatchObject({ status: "pending_review", reviewerNotes: null });
        expect(addsOf(pathB.institutionId, "tick_removed_name_proof")).toEqual([]);
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);
  },
);
