// @vitest-environment node

// The staff name decision, the tick queue read and the notice job, against real rows. Accounts come
// through the real sign-up, code verification and host step services, the Email organisasi through
// its real code services, workspaces and invitations through their services, drafts and fees
// through the competition services, requests through the real submit route handler with the Rule 16
// header, and decisions through the real decision services. A row is planted directly only where no
// production path reaches it, and each such place says so.
//
// The last describe COMMITS, because one connection cannot wait on itself: a second connection holds
// a row lock the service under test is expected to wait on. Every committed row is deleted by id in a
// finally, and what survived is asserted.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, asc, eq, inArray, or, sql } from "drizzle-orm";
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

const emailSpy = vi.hoisted(() => vi.fn(async () => {}));

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
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: vi.fn(async () => ({})),
    enqueueHostTrustRemoved: vi.fn(async () => ({})),
    enqueueInstitutionTickNotice: vi.fn(async () => ({})),
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
import { removeMember } from "@/server/institution-members/member-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import { savePaymentInstructions } from "@/server/institutions/payment-instructions-service";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { setCompetitionFee } from "@/server/competitions/competition-fee-service";
import { processInstitutionTickNoticeJob } from "@/server/async/jobs/institution-tick-notice";
import type { InstitutionTickNoticeJob } from "@/server/async/jobs/institution-tick-notice";
import { enqueueInstitutionTickNotice } from "@/server/async/enqueue";
import { absoluteSiteUrl } from "@/config/site-url";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { renameInstitutionAsStaff } from "@/server/institution-workspace/institution-staff-rename-service";
import {
  decideNameCheck,
  listTickQueue,
  sweepNameProofs,
  type NameCheckDecision,
} from "./name-check-service";
import { reviewVerificationSubmission, SubmissionError } from "./submission-service";
import { tickByOrganizationDomain } from "./tick-service";
import { VerificationError } from "./verification-core";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
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
const PAID_FEE_AMOUNT = 50_000;
const PROOF_REASON = "Kirim akta pendirian dan surat keputusan pengurus.";
const PATH_B_CLOSED_NOTE =
  "Ditutup karena staf meminta bukti nama. Bukti nama hanya dapat dikirim lewat dokumen.";

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

const noticeSpy = () => vi.mocked(enqueueInstitutionTickNotice);

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
  noticeSpy().mockClear();
  emailSpy.mockClear();
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
      email: `ops_name_${suffix}@example.test`,
      username: `ops_name_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No staff row");
  return row.id;
};

type Owner = { institutionId: string; slug: string; ownerId: string };

// T4's workspace before its tick: the owner signed up and took the host step, confirmed an Email
// organisasi (which trusts the account), created the workspace and saved its website.
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

// A host who took the host step and has no Email organisasi, so the tick of its request would trust it.
const buildUntrustedOwner = async (tx: Database): Promise<Owner> => {
  const ownerId = await signUpHost(tx, "pemilik");
  const workspace = await createInstitutionWorkspaceForUser(
    ownerId,
    { displayName: `Ruang Kerja ${freshPart()}`, institutionType: "company" },
    tx,
  );
  return { institutionId: workspace.institutionId, slug: workspace.slug, ownerId };
};

// A Path A tick: T4's workspace ticked through tickByOrganizationDomain.
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

// Where the money goes and a fee rule in force, which a paid draft needs before its fee is set.
const preparePaidSelling = async (tx: Database, owner: Owner): Promise<void> => {
  await savePaymentInstructions(
    owner.ownerId,
    owner.institutionId,
    {
      bankName: "Bank Contoh",
      accountNumber: "1234567890",
      accountHolderName: "Panitia Lomba",
      qrisR2Key: null,
      instructionsNote: null,
    },
    tx,
  );
  await tx.insert(schema.financeFeeRules).values({
    institutionId: owner.institutionId,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(Date.now() - DAY_MS),
  });
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

const createPaidDraft = async (tx: Database, owner: Owner, title: string): Promise<string> => {
  await preparePaidSelling(tx, owner);
  const competitionId = await createPublishableDraft(tx, owner, title);
  await setCompetitionFee(
    owner.ownerId,
    competitionId,
    { feeAmount: PAID_FEE_AMOUNT, feeCurrency: "IDR", feeDisclosureAcknowledged: true },
    tx,
    new Date(),
  );
  return competitionId;
};

const storedStatusOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select({ status: schema.competitions.status })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.status;
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

type SubmitAnswer = {
  status: number;
  body: { error?: { code: string }; submissionId?: string };
};

const callSubmitRoute = async (
  tx: Database,
  owner: Owner,
  body: Record<string, unknown>,
): Promise<SubmitAnswer> => {
  routeState.transaction = tx;
  routeState.actorUserId = owner.ownerId;
  const response = await submitRoute(
    new Request(`http://localhost/api/v1/institutions/${owner.slug}/verification/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: owner.ownerId },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionSlug: owner.slug }) },
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
  const answer = await callSubmitRoute(tx, owner, { documents: COMPANY_DOCUMENTS });
  expect(answer.status).toBe(201);
  return answer.body.submissionId!;
};

const submitInstagram = async (tx: Database, owner: Owner): Promise<string> => {
  const answer = await callSubmitRoute(tx, owner, INSTAGRAM_REQUEST);
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
    })
    .from(schema.platformOpsAuditLogs)
    .where(eq(schema.platformOpsAuditLogs.targetInstitutionId, institutionId));

const submissionRowsOf = (tx: Database, institutionId: string) =>
  tx
    .select({
      id: schema.institutionVerificationSubmissions.id,
      status: schema.institutionVerificationSubmissions.status,
      requestedPath: schema.institutionVerificationSubmissions.requestedPath,
      reviewerUserId: schema.institutionVerificationSubmissions.reviewerUserId,
      reviewerNotes: schema.institutionVerificationSubmissions.reviewerNotes,
    })
    .from(schema.institutionVerificationSubmissions)
    .where(eq(schema.institutionVerificationSubmissions.institutionId, institutionId))
    .orderBy(asc(schema.institutionVerificationSubmissions.submittedAt));

// "No row change": the status, the five tick columns and the audit rows of both logs.
const snapshotOf = async (tx: Database, institutionId: string) => {
  const row = await readWorkspace(tx, institutionId);
  return {
    verificationStatus: row.verificationStatus,
    tickPath: row.tickPath,
    tickDomain: row.tickDomain,
    nameCheckedAt: row.nameCheckedAt,
    nameProofDueAt: row.nameProofDueAt,
    nameProofRemindedAt: row.nameProofRemindedAt,
    verificationAuditRows: (await auditRowsOf(tx, institutionId)).length,
    platformAuditRows: (await platformAuditRowsOf(tx, institutionId)).length,
  };
};

// The due date as the exact UTC text the notice carries.
const dueTextOf = async (tx: Database, institutionId: string): Promise<string> => {
  const rows = await tx.execute<{ due: string }>(sql`
    select to_char(name_proof_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due
    from institutions where id = ${institutionId}`);
  return rows[0]!.due;
};

const noticePayloads = () => noticeSpy().mock.calls.map(([call]) => call.payload);

// A refused decision leaves every row as it was and enqueues nothing.
const expectRefusedWithoutWriting = async (
  tx: Database,
  institutionId: string,
  attempt: Promise<unknown>,
  expected: Record<string, unknown>,
  before: Awaited<ReturnType<typeof snapshotOf>>,
): Promise<void> => {
  const refused = await attempt.then(
    () => null,
    (error: unknown) => error,
  );
  expect(await snapshotOf(tx, institutionId)).toEqual(before);
  expect(noticePayloads()).toEqual([]);
  expect(refused).toMatchObject(expected);
};

describe.skipIf(skipWithoutDatabase)("the staff name decision (real database)", () => {
  it("staff find a Path A name fine", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      const paidDraftId = await createPaidDraft(tx, owner, "Lomba Berbayar");
      const precondition = await readWorkspace(tx, owner.institutionId);
      expect(precondition.tickPath).toBe("domain");
      expect(precondition.nameCheckedAt).toBeNull();
      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;
      noticeSpy().mockClear();

      const result = await decideNameCheck(
        staffId,
        owner.institutionId,
        { decision: "name_ok" },
        tx,
      );

      expect(result).toMatchObject({
        institutionId: owner.institutionId,
        decision: "name_ok",
        nameProofDueAt: null,
      });
      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.nameCheckedAt).not.toBeNull();
      expect(row.nameProofDueAt).toBeNull();
      expect(row.nameProofRemindedAt).toBeNull();
      expect(row.tickPath).toBe("domain");
      expect(await platformAuditRowsOf(tx, owner.institutionId)).toEqual([
        {
          actorUserId: staffId,
          targetInstitutionId: owner.institutionId,
          eventType: "institution_tick.name_checked",
          reason: null,
        },
      ]);
      const audit = await auditRowsOf(tx, owner.institutionId);
      expect(audit).toHaveLength(auditBefore + 1);
      expect(audit.at(-1)).toEqual({
        fromStatus: "verified",
        toStatus: "verified",
        reason: null,
        actorUserId: staffId,
      });
      // One notice for the workspace: the notice job reaches every active owner.
      expect(noticePayloads()).toEqual([
        { institutionId: owner.institutionId, kind: "name_checked", epoch: expect.any(Number) },
      ]);
      expect(noticePayloads()[0]).not.toHaveProperty("reason");
      expect(noticePayloads()[0]).not.toHaveProperty("dueAt");

      const pressed = await pressPublish(tx, owner, paidDraftId);

      expect(pressed.status).toBe(200);
      expect(await storedStatusOf(tx, paidDraftId)).toBe("published");
    });
  });

  it("staff ask for proof: 28 days, no name check", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;
      noticeSpy().mockClear();

      await decideNameCheck(
        staffId,
        owner.institutionId,
        { decision: "require_proof", reason: PROOF_REASON },
        tx,
      );

      const sameInstant = await tx.execute<{ same: boolean }>(sql`
        select name_proof_due_at = now() + interval '28 days' as same
        from institutions where id = ${owner.institutionId}`);
      expect(sameInstant[0]!.same).toBe(true);
      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.nameProofRemindedAt).toBeNull();
      expect(row.nameCheckedAt).toBeNull();
      expect(row.tickPath).toBe("domain");
      expect(await platformAuditRowsOf(tx, owner.institutionId)).toEqual([
        {
          actorUserId: staffId,
          targetInstitutionId: owner.institutionId,
          eventType: "institution_tick.name_proof_requested",
          reason: PROOF_REASON,
        },
      ]);
      const audit = await auditRowsOf(tx, owner.institutionId);
      expect(audit).toHaveLength(auditBefore + 1);
      expect(audit.at(-1)).toMatchObject({
        fromStatus: "verified",
        toStatus: "verified",
        reason: PROOF_REASON,
      });
      expect(noticePayloads()).toEqual([
        {
          institutionId: owner.institutionId,
          kind: "name_proof_requested",
          reason: PROOF_REASON,
          dueAt: await dueTextOf(tx, owner.institutionId),
          epoch: expect.any(Number),
        },
      ]);

      const before = await snapshotOf(tx, owner.institutionId);
      noticeSpy().mockClear();
      await expectRefusedWithoutWriting(
        tx,
        owner.institutionId,
        decideNameCheck(
          staffId,
          owner.institutionId,
          { decision: "require_proof", reason: "Alasan lain." },
          tx,
        ),
        { code: "institution_name_proof_running", status: 409 },
        before,
      );
    });
  });

  it("the decision guards", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      const before = await snapshotOf(tx, owner.institutionId);

      // A candidate account is not an operator.
      const candidateId = await signUpParticipant(tx, `calon.${freshPart()}@pemilik.local`);
      await expectRefusedWithoutWriting(
        tx,
        owner.institutionId,
        decideNameCheck(candidateId, owner.institutionId, { decision: "name_ok" }, tx),
        { code: "operator_actor_not_platform_ops", status: 403 },
        before,
      );
      const asOperatorError = await refusalOf(
        decideNameCheck(candidateId, owner.institutionId, { decision: "name_ok" }, tx),
      );
      expect(asOperatorError).toBeInstanceOf(OperatorActorError);

      // The conflict rule's own tests prove every relationship; one membership shows the call is made.
      const memberOperator = await seedStaff(tx);
      await tx.insert(schema.institutionMemberships).values({
        institutionId: owner.institutionId,
        userId: memberOperator,
        membershipRole: "institution_member",
        status: "active",
      });
      await expectRefusedWithoutWriting(
        tx,
        owner.institutionId,
        decideNameCheck(memberOperator, owner.institutionId, { decision: "name_ok" }, tx),
        { code: "operator_actor_conflicted", status: 403 },
        before,
      );

      // A documents tick has no organization email tick whose name staff can check.
      const documentsOwner = await buildUntickedOwner(tx);
      await approve(tx, staffId, await submitDocuments(tx, documentsOwner));
      expect((await readWorkspace(tx, documentsOwner.institutionId)).tickPath).toBe("documents");
      noticeSpy().mockClear();
      await expectRefusedWithoutWriting(
        tx,
        documentsOwner.institutionId,
        decideNameCheck(staffId, documentsOwner.institutionId, { decision: "name_ok" }, tx),
        { code: "institution_name_check_not_applicable", status: 409 },
        await snapshotOf(tx, documentsOwner.institutionId),
      );

      // A reason of the wrong length is refused before any read.
      const invalidReasons: NameCheckDecision[] = [
        // The type forbids a missing reason, and the service must still refuse one.
        { decision: "require_proof" } as unknown as NameCheckDecision,
        { decision: "require_proof", reason: "" },
        { decision: "require_proof", reason: "   " },
        { decision: "require_proof", reason: "a".repeat(1001) },
        { decision: "name_ok", reason: "a".repeat(1001) },
      ];
      for (const decision of invalidReasons) {
        await expectRefusedWithoutWriting(
          tx,
          owner.institutionId,
          decideNameCheck(staffId, owner.institutionId, decision, tx),
          { code: "institution_name_check_reason_invalid", status: 400 },
          before,
        );
      }

      // While a proof runs, accepting the name needs a reason.
      await decideNameCheck(
        staffId,
        owner.institutionId,
        { decision: "require_proof", reason: PROOF_REASON },
        tx,
      );
      noticeSpy().mockClear();
      const duringProof = await snapshotOf(tx, owner.institutionId);
      for (const decision of [
        { decision: "name_ok" },
        { decision: "name_ok", reason: "   " },
      ] satisfies NameCheckDecision[]) {
        await expectRefusedWithoutWriting(
          tx,
          owner.institutionId,
          decideNameCheck(staffId, owner.institutionId, decision, tx),
          { code: "institution_name_check_reason_required", status: 422 },
          duringProof,
        );
      }

      const auditBefore = (await auditRowsOf(tx, owner.institutionId)).length;
      const accepted = "Dokumen yang dikirim melalui halaman kontak sudah sesuai.";
      await decideNameCheck(
        staffId,
        owner.institutionId,
        { decision: "name_ok", reason: accepted },
        tx,
      );

      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.nameCheckedAt).not.toBeNull();
      expect(row.nameProofDueAt).toBeNull();
      expect(row.nameProofRemindedAt).toBeNull();
      const platformRows = await platformAuditRowsOf(tx, owner.institutionId);
      expect(platformRows).toContainEqual({
        actorUserId: staffId,
        targetInstitutionId: owner.institutionId,
        eventType: "institution_tick.name_checked",
        reason: accepted,
      });
      const audit = await auditRowsOf(tx, owner.institutionId);
      expect(audit).toHaveLength(auditBefore + 1);
      expect(audit.at(-1)?.reason).toBe(accepted);

      // With no proof running the reason is optional.
      const calm = await buildPathATick(tx);
      await expect(
        decideNameCheck(staffId, calm.institutionId, { decision: "name_ok" }, tx),
      ).resolves.toMatchObject({ decision: "name_ok" });
    });
  });

  it("Minta bukti nama frees the pending slot for documents", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const staffId = await seedStaff(tx);
      const instagramRequestId = await submitInstagram(tx, owner);

      await decideNameCheck(
        staffId,
        owner.institutionId,
        { decision: "require_proof", reason: PROOF_REASON },
        tx,
      );

      const [closed] = await submissionRowsOf(tx, owner.institutionId);
      expect(closed).toMatchObject({
        id: instagramRequestId,
        status: "rejected",
        reviewerUserId: staffId,
        reviewerNotes: PATH_B_CLOSED_NOTE,
      });

      const documentsAnswer = await callSubmitRoute(tx, owner, { documents: COMPANY_DOCUMENTS });
      expect(documentsAnswer.status).toBe(201);

      // Planted directly: a 28-day wait has no production path. The due date falls after the request
      // was submitted and before the sweep's time.
      const sweepNow = new Date(Date.now() + 60_000);
      await tx
        .update(schema.institutions)
        .set({ nameProofDueAt: new Date(Date.now() + 30_000) })
        .where(eq(schema.institutions.id, owner.institutionId));

      await sweepNameProofs(sweepNow, tx);

      const row = await readWorkspace(tx, owner.institutionId);
      expect(row.verificationStatus).toBe("verified");
      expect(row.tickPath).toBe("domain");
    });
  });

  it("the tick queue lists requests, name checks due and running proofs, and nothing else", async () => {
    await inRollback(async (tx) => {
      const staffId = await seedStaff(tx);

      // A Path B request on a workspace with no tick, aged by an UPDATE: no production path ages a
      // request.
      const requested = await buildUntrustedOwner(tx);
      const requestId = await submitInstagram(tx, requested);
      await tx
        .update(schema.institutionVerificationSubmissions)
        .set({ submittedAt: sql`now() - interval '8 days'` })
        .where(eq(schema.institutionVerificationSubmissions.id, requestId));

      const nameCheckDue = await buildPathATick(tx);
      const paidDraftId = await createPaidDraft(tx, nameCheckDue, "Lomba Berbayar");

      const freeOnly = await buildPathATick(tx);
      await createPublishableDraft(tx, freeOnly, "Lomba Gratis");

      const proofRunning = await buildPathATick(tx);
      await createPaidDraft(tx, proofRunning, "Lomba Berbayar Lain");
      await decideNameCheck(
        staffId,
        proofRunning.institutionId,
        { decision: "require_proof", reason: PROOF_REASON },
        tx,
      );

      const documentsTick = await buildUntickedOwner(tx);
      await approve(tx, staffId, await submitDocuments(tx, documentsTick));
      await createPaidDraft(tx, documentsTick, "Lomba Berbayar Dokumen");

      const queue = await listTickQueue(tx);

      const requestFor = queue.requests.find(
        (request) => request.institutionId === requested.institutionId,
      );
      expect(requestFor).toMatchObject({
        submissionId: requestId,
        institutionSlug: requested.slug,
        requestedPath: "instagram",
        instagramUrl: "https://www.instagram.com/acme.org/",
        pageUrl: absoluteSiteUrl(`/institution/${requested.slug}`),
        submittedByUserId: requested.ownerId,
        submitterWouldBeTrusted: true,
        overdue: true,
        documentCount: 0,
        closure: null,
        lastLeftVerified: null,
        siblingClosures: [],
      });

      const nameCheckIds = queue.nameChecks.map((entry) => entry.institutionId);
      expect(nameCheckIds).toContain(nameCheckDue.institutionId);
      expect(nameCheckIds).not.toContain(freeOnly.institutionId);
      expect(nameCheckIds).not.toContain(proofRunning.institutionId);
      expect(nameCheckIds).not.toContain(documentsTick.institutionId);
      expect(
        queue.nameChecks.find((entry) => entry.institutionId === nameCheckDue.institutionId),
      ).toMatchObject({
        tickDomain: "acme.example",
        ownerEmailDomains: ["students.acme.example"],
        paidDraft: {
          competitionId: paidDraftId,
          title: "Lomba Berbayar",
          feeAmount: PAID_FEE_AMOUNT,
          feeCurrency: "IDR",
        },
        siblingClosures: [],
      });

      const proofIds = queue.runningProofs.map((entry) => entry.institutionId);
      expect(proofIds).toContain(proofRunning.institutionId);
      expect(proofIds).not.toContain(nameCheckDue.institutionId);
      expect(proofIds).not.toContain(freeOnly.institutionId);
      expect(proofIds).not.toContain(documentsTick.institutionId);
      expect(
        queue.runningProofs.find((entry) => entry.institutionId === proofRunning.institutionId),
      ).toMatchObject({ reminded: false });

      const requestIds = queue.requests.map((request) => request.institutionId);
      for (const unlisted of [freeOnly, documentsTick, nameCheckDue, proofRunning]) {
        expect(requestIds).not.toContain(unlisted.institutionId);
      }
    });
  });

  it("every staff decision reaches every active owner in the inbox and by email", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const secondOwner = await addCoOwner(tx, owner);
      const revokedOwner = await addCoOwner(tx, owner);
      const [revokedMembership] = await tx
        .select({ id: schema.institutionMemberships.id })
        .from(schema.institutionMemberships)
        .where(
          and(
            eq(schema.institutionMemberships.institutionId, owner.institutionId),
            eq(schema.institutionMemberships.userId, revokedOwner),
          ),
        );
      await removeMember(owner.ownerId, owner.slug, revokedMembership!.id, tx);
      const workspace = await readWorkspace(tx, owner.institutionId);

      routeState.transaction = tx;
      await processInstitutionTickNoticeJob({
        id: "job_tick_notice",
        data: { institutionId: owner.institutionId, kind: "tick_granted", epoch: 1 },
        updateData: async () => undefined,
      } as unknown as InstitutionTickNoticeJob);

      const title = "Ruang kerja Anda terverifikasi";
      const body = `${workspace.displayName} kini memiliki centang terverifikasi.`;
      const inbox = await tx
        .select({
          userId: schema.notifications.userId,
          type: schema.notifications.type,
          title: schema.notifications.title,
          body: schema.notifications.body,
        })
        .from(schema.notifications)
        .where(inArray(schema.notifications.userId, [owner.ownerId, secondOwner, revokedOwner]));
      expect(inbox).toHaveLength(2);
      expect(inbox.map((row) => row.userId).sort()).toEqual([owner.ownerId, secondOwner].sort());
      for (const row of inbox) {
        expect(row).toMatchObject({ type: "institution_tick_notice", title, body });
      }

      const addresses = await tx
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, [owner.ownerId, secondOwner]));
      expect(emailSpy).toHaveBeenCalledTimes(2);
      for (const address of addresses) {
        expect(emailSpy).toHaveBeenCalledWith(
          expect.objectContaining({ toEmail: address.email, recipientId: address.id, title, body }),
        );
      }
    });
  });
});

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
  "the name decision waits for a committed row lock (committed rows)",
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
      const database = asDatabase(control);
      const owner = await buildPathATick(database);
      createdUserIds.push(owner.ownerId);
      createdInstitutionIds.push(owner.institutionId);
      return owner;
    };

    const seedCommittedStaff = async (): Promise<string> => {
      const staffId = await seedStaff(asDatabase(control));
      createdUserIds.push(staffId);
      return staffId;
    };

    const platformEventsOf = async (institutionId: string): Promise<string[]> =>
      (await platformAuditRowsOf(asDatabase(control), institutionId)).map((row) => row.eventType);

    it("a reason-less Nama sesuai racing Minta bukti nama does not end the new proof", async () => {
      try {
        const owner = await seedCommittedPathATick();
        const staffId = await seedCommittedStaff();
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);
        let proofDueAt: Date | null = null;

        const outcome = await holdTransactionWhile(
          holder,
          async (tx) => {
            const proof = await decideNameCheck(
              staffId,
              owner.institutionId,
              { decision: "require_proof", reason: PROOF_REASON },
              tx,
            );
            proofDueAt = proof.nameProofDueAt;
          },
          async () => {
            const running = settle(
              decideNameCheck(
                staffId,
                owner.institutionId,
                { decision: "name_ok" },
                asDatabase(racer),
              ),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the name_ok");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({
          code: "institution_name_check_reason_required",
          status: 422,
        });
        const row = await readWorkspace(asDatabase(control), owner.institutionId);
        expect(proofDueAt).not.toBeNull();
        expect(row.nameProofDueAt).toEqual(proofDueAt);
        expect(row.nameCheckedAt).toBeNull();
        expect(await platformEventsOf(owner.institutionId)).not.toContain(
          "institution_tick.name_checked",
        );
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);

    it("two Minta bukti nama racing start one proof", async () => {
      try {
        const owner = await seedCommittedPathATick();
        const firstStaff = await seedCommittedStaff();
        const secondStaff = await seedCommittedStaff();
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);
        const firstReason = "Alasan pertama: kirim akta.";
        const secondReason = "Alasan kedua: kirim surat keputusan.";
        let firstDueAt: Date | null = null;

        const outcome = await holdTransactionWhile(
          holder,
          async (tx) => {
            const proof = await decideNameCheck(
              firstStaff,
              owner.institutionId,
              { decision: "require_proof", reason: firstReason },
              tx,
            );
            firstDueAt = proof.nameProofDueAt;
          },
          async () => {
            const running = settle(
              decideNameCheck(
                secondStaff,
                owner.institutionId,
                { decision: "require_proof", reason: secondReason },
                asDatabase(racer),
              ),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the second Minta bukti nama");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({ code: "institution_name_proof_running", status: 409 });
        const row = await readWorkspace(asDatabase(control), owner.institutionId);
        expect(firstDueAt).not.toBeNull();
        expect(row.nameProofDueAt).toEqual(firstDueAt);
        const requested = (
          await platformAuditRowsOf(asDatabase(control), owner.institutionId)
        ).filter((auditRow) => auditRow.eventType === "institution_tick.name_proof_requested");
        expect(requested).toHaveLength(1);
        expect(requested[0]?.reason).toBe(firstReason);
        const notices = noticePayloads().filter(
          (payload) =>
            payload.institutionId === owner.institutionId &&
            payload.kind === "name_proof_requested",
        );
        expect(notices).toHaveLength(1);
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);

    it("a name decision and a staff rename miss when an approval moved the tick off domain", async () => {
      try {
        const owner = await seedCommittedPathATick();
        const staffId = await seedCommittedStaff();
        const database = asDatabase(control);
        const requestId = await submitDocuments(database, owner);
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);

        const outcome = await holdTransactionWhile(
          holder,
          (tx) => reviewVerificationSubmission(requestId, "approved", null, staffId, tx),
          async () => {
            const running = settle(
              decideNameCheck(
                staffId,
                owner.institutionId,
                { decision: "name_ok", reason: "Nama sesuai dokumen." },
                asDatabase(racer),
              ),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the name decision");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({ code: "verification_transition_conflict", status: 409 });
        const row = await readWorkspace(database, owner.institutionId);
        expect(row.tickPath).toBe("documents");
        expect(row.nameCheckedAt).toBeNull();
        expect(await platformEventsOf(owner.institutionId)).not.toContain(
          "institution_tick.name_checked",
        );

        const renamed = await seedCommittedPathATick();
        const renameRequestId = await submitDocuments(database, renamed);
        const before = await readWorkspace(database, renamed.institutionId);

        const renameOutcome = await holdTransactionWhile(
          holder,
          (tx) => reviewVerificationSubmission(renameRequestId, "approved", null, staffId, tx),
          async () => {
            const running = settle(
              renameInstitutionAsStaff(
                staffId,
                renamed.institutionId,
                { displayName: `Nama Baru ${freshPart()}`, reason: "Nama disesuaikan dokumen." },
                asDatabase(racer),
              ),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the staff rename");
            return { racer: running };
          },
        );

        expect(renameOutcome.ok).toBe(false);
        const renameError = !renameOutcome.ok ? renameOutcome.error : null;
        expect(renameError).toBeInstanceOf(VerificationError);
        expect(renameError).toMatchObject({
          code: "verification_transition_conflict",
          status: 409,
        });
        const renamedRow = await readWorkspace(database, renamed.institutionId);
        expect(renamedRow.tickPath).toBe("documents");
        expect(renamedRow.displayName).toBe(before.displayName);
        expect(renamedRow.slug).toBe(before.slug);
        expect(renamedRow.nameCheckedAt).toBeNull();
        expect(await platformEventsOf(renamed.institutionId)).not.toContain(
          "institution.renamed_by_staff",
        );
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);

    it("a proof request that commits under a Path B approval survives it", async () => {
      try {
        const owner = await seedCommittedPathATick();
        const staffId = await seedCommittedStaff();
        const database = asDatabase(control);
        const requestId = await submitInstagram(database, owner);
        const holderPid = await backendPidOf(holder);
        const racerPid = await backendPidOf(racer);
        let proofDueAt: Date | null = null;

        const outcome = await holdTransactionWhile(
          holder,
          async (tx) => {
            const proof = await decideNameCheck(
              staffId,
              owner.institutionId,
              { decision: "require_proof", reason: PROOF_REASON },
              tx,
            );
            proofDueAt = proof.nameProofDueAt;
          },
          async () => {
            const running = settle(
              reviewVerificationSubmission(requestId, "approved", null, staffId, asDatabase(racer)),
            );
            await awaitBlockedBy(control, racerPid, holderPid, "the Path B approval");
            return { racer: running };
          },
        );

        expect(outcome.ok).toBe(false);
        const error = !outcome.ok ? outcome.error : null;
        expect(error).toBeInstanceOf(SubmissionError);
        expect(error).toMatchObject({
          code: "institution_name_proof_needs_documents",
          status: 409,
        });
        const row = await readWorkspace(database, owner.institutionId);
        expect(row.tickPath).toBe("domain");
        expect(proofDueAt).not.toBeNull();
        expect(row.nameProofDueAt).toEqual(proofDueAt);
        const [request] = await submissionRowsOf(database, owner.institutionId);
        expect(request).toMatchObject({
          id: requestId,
          status: "rejected",
          reviewerNotes: PATH_B_CLOSED_NOTE,
        });
      } finally {
        await sweep();
        expect(await survivors()).toEqual({ users: 0, institutions: 0, auditLogs: 0 });
      }
    }, 60_000);
  },
);
