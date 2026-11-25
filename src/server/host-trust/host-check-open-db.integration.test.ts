// @vitest-environment node

// The publish press and the host check it opens, against real rows in a rolled-back transaction.
// Accounts come through the real sign-up, code verification and host step services, workspaces
// and drafts through the real institution and competition services, and each press through the
// real publish route. A row is planted directly only where this file does not drive its writer,
// and each such helper says so. The last describe commits, because two presses at once need two
// connections.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
}));

// The route reads the pooled connection and the session cookie, and this process has neither. Both
// are staged per press and reset before each test.
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
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => routeState.transaction ?? actual.getDb() };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) throw new Error("the publish route ran with no session staged");
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
  NEW_INSTITUTION_DEFAULT_STATUS,
  createPersonalInstitutionForUser,
} from "@/server/institution-workspace/institution-service";
import { changeMemberRole } from "@/server/institution-members/member-service";
import {
  createCompetitionDraft,
  softDeleteCompetitionDraft,
  unpublishCompetition,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { resolveCompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
import { publishOrOpenHostCheck } from "./host-check-service";
import { POST as publishRoute } from "@/app/api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route";
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

// Planted directly: the host step trusts a confirmed sign-in email on an organization domain at
// once, so only an older account holds the host role on such a domain without trust.
const signUpLegacyHost = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await tx
    .update(schema.users)
    .set({ recruiterVerifiedAt: new Date(), recruiterVerificationTier: "minimal" })
    .where(eq(schema.users.id, userId));
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

// Planted directly: a stand-in for a removal from the workspace, which this file does not drive.
const plantMembershipEnded = async (
  tx: Database,
  institutionId: string,
  userId: string,
): Promise<void> => {
  await tx
    .update(schema.institutionMemberships)
    .set({ status: "inactive" })
    .where(
      and(
        eq(schema.institutionMemberships.institutionId, institutionId),
        eq(schema.institutionMemberships.userId, userId),
      ),
    );
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

// Planted directly: a stand-in for the owner's price setting, which this file does not drive.
const plantPaidPrice = async (tx: Database, competitionId: string): Promise<void> => {
  await tx
    .update(schema.competitions)
    .set({ feeAmount: 50_000, feeCurrency: "IDR" })
    .where(eq(schema.competitions.id, competitionId));
};

// Planted directly: a stand-in for a staff verification of the institution, which this file does not drive.
const plantInstitutionVerified = async (tx: Database, institutionId: string): Promise<void> => {
  await tx
    .update(schema.institutions)
    .set({ verificationStatus: "verified" })
    .where(eq(schema.institutions.id, institutionId));
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

// Planted directly: a host request without a draft, closed as migration 0071 closes it.
const plantClosedRequestWithoutDraft = async (
  tx: Database,
  userId: string,
  fullName: string,
  mobileNumber: string,
): Promise<void> => {
  await tx.insert(schema.recruiterVerificationSubmissions).values({
    userId,
    fullName,
    mobileNumber,
    status: "rejected",
    rejectionReason: "Ditutup karena alur penyelenggara berubah.",
    resubmissionAllowed: false,
    reviewedAt: new Date(),
  });
};

// Planted directly: a stand-in for a staff turn-down of a host check, which this file does not drive.
const plantStaffTurnDown = async (
  tx: Database,
  userId: string,
  competitionId: string,
  reviewedAt: Date,
): Promise<void> => {
  await tx.insert(schema.recruiterVerificationSubmissions).values({
    userId,
    competitionId,
    fullName: "Rina Pratama",
    mobileNumber: "0812345678",
    status: "rejected",
    guidelineItem: "kontak-nyata",
    rejectionReason: "Nomor kontak tidak aktif.",
    resubmissionAllowed: false,
    reviewedAt,
  });
};

// Planted directly: a host with no participant details, which only accounts from before sign-up
// asked for them hold. Its sign-in email is unconfirmed, so no automatic source holds.
const plantHostWithoutParticipantDetails = async (tx: Database): Promise<string> => {
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: "lama.host@acme.example",
      username: `lama_host_${randomUUID().slice(0, 8)}`,
      role: "recruiter",
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "minimal",
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No user row");
  return row.id;
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

// Planted directly: an approved host request without a draft, as older accounts hold.
const plantApprovedRequestWithoutDraft = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .insert(schema.recruiterVerificationSubmissions)
    .values({
      userId,
      fullName: "Rina Pratama",
      mobileNumber: "0812345678",
      status: "approved",
      reviewedAt: new Date(),
    })
    .returning({ id: schema.recruiterVerificationSubmissions.id });
  if (!row) throw new Error("No host request row");
  return row.id;
};

// Planted directly: a stand-in for the editor's mode change, which this file does not drive.
const plantTeamMode = async (tx: Database, competitionId: string): Promise<void> => {
  await tx
    .update(schema.competitions)
    .set({ mode: "team", minTeamSize: 2, maxTeamSize: 4 })
    .where(eq(schema.competitions.id, competitionId));
};

const createDraftMissing = async (
  tx: Database,
  authorId: string,
  institutionSlug: string,
  title: string,
  missing: "contact" | "audience",
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
  if (missing === "contact") {
    await setCompetitionEligibilityForEditor(authorId, draft.id, { audience: ["umum"] }, tx);
  }
  if (missing === "audience") {
    await setCompetitionOrganizerContactForEditor(
      authorId,
      draft.id,
      { kind: "whatsapp", value: "081298765432" },
      tx,
    );
  }
  return draft.id;
};

const submissionRowsOf = (tx: Database, userIds: string[]) =>
  tx
    .select()
    .from(schema.recruiterVerificationSubmissions)
    .where(inArray(schema.recruiterVerificationSubmissions.userId, userIds))
    .orderBy(schema.recruiterVerificationSubmissions.id);

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

const organizationEmailRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      email: schema.hostOrganizationEmails.email,
      domain: schema.hostOrganizationEmails.domain,
    })
    .from(schema.hostOrganizationEmails)
    .where(eq(schema.hostOrganizationEmails.userId, userId));

const hostCheckRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      competitionId: schema.recruiterVerificationSubmissions.competitionId,
      status: schema.recruiterVerificationSubmissions.status,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.userId, userId));

const openHostChecksOf = (tx: Database, userId: string) =>
  tx
    .select({
      competitionId: schema.recruiterVerificationSubmissions.competitionId,
      status: schema.recruiterVerificationSubmissions.status,
      fullName: schema.recruiterVerificationSubmissions.fullName,
      mobileNumber: schema.recruiterVerificationSubmissions.mobileNumber,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(
      and(
        eq(schema.recruiterVerificationSubmissions.userId, userId),
        inArray(schema.recruiterVerificationSubmissions.status, ["draft", "pending_review"]),
      ),
    );

const hostCheckRowOf = async (tx: Database, id: string) => {
  const [row] = await tx
    .select({
      status: schema.recruiterVerificationSubmissions.status,
      rejectionReason: schema.recruiterVerificationSubmissions.rejectionReason,
      guidelineItem: schema.recruiterVerificationSubmissions.guidelineItem,
      resubmissionAllowed: schema.recruiterVerificationSubmissions.resubmissionAllowed,
      reviewedAt: schema.recruiterVerificationSubmissions.reviewedAt,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.id, id));
  if (!row) throw new Error("No host check row");
  return row;
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

const readinessOf = (tx: Database, actorUserId: string, competitionId: string) =>
  resolveCompetitionPublishReadiness(actorUserId, competitionId, tx);

const pressOn = (tx: Database, actorUserId: string, workspace: Workspace, competitionId: string) =>
  pressPublishThroughRoute(tx, actorUserId, workspace.slug, competitionId);

const expectedOpenCheck = (competitionId: string) => ({
  competitionId,
  status: "pending_review",
  fullName: "Rina Pratama",
  mobileNumber: "0812345678",
});

const expectedClosedCheck = (reason: string) => ({
  status: "rejected",
  rejectionReason: reason,
  guidelineItem: null,
  resubmissionAllowed: false,
  reviewedAt: expect.any(Date),
});

const TRUSTED_BY_SIGN_IN_EMAIL = "budi.host@acme.example";
const UNTRUSTED_HOST_ADDRESS = "rina.free@gmail.com";
const SECOND_UNTRUSTED_HOST_ADDRESS = "sari.free@gmail.com";
const FIRST_TITLE = "Lomba Esai Nasional";
const SECOND_TITLE = "Lomba Poster Digital";
const GONE_DRAFT_REASON = "Ditutup karena draf tidak lagi tersedia.";
const NEEDED_READINESS = {
  canPublish: true,
  blockers: [],
  hostCheck: { state: "needed" },
};
const NOT_NEEDED_READINESS = {
  canPublish: true,
  blockers: [],
  hostCheck: { state: "not_needed" },
};

describe.skipIf(skipWithoutDatabase)("the publish press (rolled back)", () => {
  it("opens a host check instead of publishing when an untrusted host presses publish", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(pressed.body.hostCheck).toEqual({
        id: expect.any(String),
        status: "pending_review",
        submittedAt: expect.any(String),
      });
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await openHostChecksOf(tx, host)).toEqual([expectedOpenCheck(draft)]);
    });
  });

  it("publishes at once when a host trusted by its sign-in email presses publish", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, owner, workspace, draft);

      expect(pressed.status).toBe(200);
      expect(pressed.body.competition?.status).toBe("published");
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await hostCheckRowsOf(tx, owner)).toEqual([]);
    });
  });

  it("trusts an older untrusted host on an organization domain at the press and publishes", async () => {
    await inRollback(async (tx) => {
      const host = await signUpLegacyHost(tx, "budi.lama@acme.example");
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(200);
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await tierOf(tx, host)).toBe("elevated");
      expect(await organizationEmailRowsOf(tx, host)).toEqual([
        { email: "budi.lama@acme.example", domain: "acme.example" },
      ]);
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
    });
  });

  it("lets staff of a workspace whose owner is trusted publish, and sends that staff to a host check once the owner's trust is gone", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const first = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const second = await createPublishableDraft(tx, owner, workspace.slug, SECOND_TITLE);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");

      const published = await pressOn(tx, staff, workspace, first);

      expect(published.status).toBe(200);
      expect(await competitionStatusOf(tx, first)).toBe("published");
      expect(await hostCheckRowsOf(tx, staff)).toEqual([]);

      await plantTrustRemoval(tx, owner);
      const sent = await pressOn(tx, staff, workspace, second);

      expect(sent.status).toBe(202);
      expect(await competitionStatusOf(tx, second)).toBe("draft");
      expect(await openHostChecksOf(tx, staff)).toEqual([expectedOpenCheck(second)]);
    });
  });

  it("opens a host check for staff whose trust staff removed, even in a workspace whose owner is trusted", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");
      await plantTrustRemoval(tx, staff);

      const pressed = await pressOn(tx, staff, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
      expect(await openHostChecksOf(tx, staff)).toEqual([expectedOpenCheck(draft)]);
    });
  });

  it("keeps a draft behind a host check when the actor's only trusted owner runs another institution", async () => {
    await inRollback(async (tx) => {
      const ownerA = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const workspaceA = await ownWorkspace(tx, ownerA);
      const draftA = await createPublishableDraft(tx, ownerA, workspaceA.slug, FIRST_TITLE);
      const ownerB = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspaceB = await ownWorkspace(tx, ownerB);
      const actor = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspaceA.institutionId, actor, "institution_staff");
      await plantMembership(tx, workspaceB.institutionId, actor, "institution_staff");

      const pressed = await pressOn(tx, actor, workspaceA, draftA);

      expect(pressed.status).toBe(202);
      expect(await competitionStatusOf(tx, draftA)).toBe("draft");
      expect(await openHostChecksOf(tx, actor)).toEqual([expectedOpenCheck(draftA)]);
    });
  });

  it("refuses an institution_member and writes no trust and no host check", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const member = await signUpLegacyHost(tx, "dina.lama@acme.example");
      await plantMembership(tx, workspace.institutionId, member, "institution_member");

      const pressed = await pressOn(tx, member, workspace, draft);

      expect(pressed.status).toBe(403);
      expect(pressed.body.error?.code).toBe("forbidden");
      expect(await tierOf(tx, member)).toBe("minimal");
      expect(await organizationEmailRowsOf(tx, member)).toEqual([]);
      expect(await hostCheckRowsOf(tx, member)).toEqual([]);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("refuses a host who runs another workspace, by membership and by the route's workspace check, and writes no trust", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const stranger = await signUpLegacyHost(tx, "dina.lama@acme.example");
      const strangerWorkspace = await ownWorkspace(tx, stranger);

      const byMembership = await pressOn(tx, stranger, workspace, draft);
      const bySlug = await pressPublishThroughRoute(tx, stranger, strangerWorkspace.slug, draft);

      expect(byMembership.status).toBe(403);
      expect(byMembership.body.error?.code).toBe("forbidden");
      expect(bySlug.status).toBe(404);
      expect(bySlug.body.error?.code).toBe("competition_not_found");
      expect(await tierOf(tx, stranger)).toBe("minimal");
      expect(await organizationEmailRowsOf(tx, stranger)).toEqual([]);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("refuses an operational account that holds the old host timestamps and writes no trust", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const operator = await signUpLegacyHost(tx, "ops.host@acme.example");
      await tx
        .update(schema.users)
        .set({ role: "platform_ops" })
        .where(eq(schema.users.id, operator));

      const pressed = await pressOn(tx, operator, workspace, draft);

      expect(pressed.status).toBe(403);
      expect(pressed.body.error?.code).toBe("forbidden");
      expect(await tierOf(tx, operator)).toBe("minimal");
      expect(await organizationEmailRowsOf(tx, operator)).toEqual([]);
    });
  });

  it("closes an open host request without a draft and opens the host check in the same press", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const requestId = await plantOpenRequestWithoutDraft(tx, host);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await hostCheckRowOf(tx, requestId)).toEqual(
        expectedClosedCheck("Ditutup karena alur penyelenggara berubah."),
      );
      expect(await openHostChecksOf(tx, host)).toEqual([expectedOpenCheck(draft)]);
    });
  });

  it("answers a second press on the same draft with the same host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const first = await pressOn(tx, host, workspace, draft);
      const second = await pressOn(tx, host, workspace, draft);

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.hostCheck?.id).toBe(first.body.hostCheck?.id);
      expect(await openHostChecksOf(tx, host)).toEqual([expectedOpenCheck(draft)]);
    });
  });

  it("refuses a press on a second draft while the first waits for its host check, and names the first", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const first = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      const second = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
      await pressOn(tx, host, workspace, first);

      const pressed = await pressOn(tx, host, workspace, second);

      expect(pressed.status).toBe(409);
      expect(pressed.body.error?.code).toBe("host_check_pending_other_draft");
      expect(pressed.body.error?.details).toEqual({ pendingCompetitionTitle: FIRST_TITLE });
      expect(await competitionStatusOf(tx, second)).toBe("draft");
      expect(await openHostChecksOf(tx, host)).toEqual([expectedOpenCheck(first)]);
    });
  });

  it("names no draft of a workspace the host has left, in the refusal and in readiness", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const theirs = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const hostWorkspace = await ownWorkspace(tx, host);
      const mine = await createPublishableDraft(tx, host, hostWorkspace.slug, SECOND_TITLE);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const sent = await pressOn(tx, host, ownerWorkspace, theirs);
      expect(sent.status).toBe(202);
      await plantMembershipEnded(tx, ownerWorkspace.institutionId, host);

      const pressed = await pressOn(tx, host, hostWorkspace, mine);

      expect(pressed.status).toBe(409);
      expect(pressed.body.error?.code).toBe("host_check_pending_other_draft");
      expect(pressed.body.error?.details).toBeUndefined();
      expect(await readinessOf(tx, host, mine)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "pending_other_draft" },
      });
    });
  });

  it("closes the host check of a deleted draft and opens one on the next draft", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const first = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      const second = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
      const opened = await pressOn(tx, host, workspace, first);
      await softDeleteCompetitionDraft(host, first, tx);

      const pressed = await pressOn(tx, host, workspace, second);

      expect(pressed.status).toBe(202);
      expect(await hostCheckRowOf(tx, opened.body.hostCheck!.id)).toEqual(
        expectedClosedCheck(GONE_DRAFT_REASON),
      );
      expect(await openHostChecksOf(tx, host)).toEqual([expectedOpenCheck(second)]);
    });
  });

  it("closes the host check of a draft the owner published and opens one on the next draft", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const first = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const second = await createPublishableDraft(tx, owner, workspace.slug, SECOND_TITLE);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");
      await plantTrustRemoval(tx, staff);
      const opened = await pressOn(tx, staff, workspace, first);
      expect(opened.status).toBe(202);
      const ownerPress = await pressOn(tx, owner, workspace, first);
      expect(ownerPress.status).toBe(200);

      const pressed = await pressOn(tx, staff, workspace, second);

      expect(pressed.status).toBe(202);
      expect(await hostCheckRowOf(tx, opened.body.hostCheck!.id)).toEqual(
        expectedClosedCheck(GONE_DRAFT_REASON),
      );
      expect(await openHostChecksOf(tx, staff)).toEqual([expectedOpenCheck(second)]);
    });
  });

  it("answers an incomplete draft of an untrusted host with the checklist refusal and opens no host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createIncompleteDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(422);
      expect(pressed.body.error?.code).toBe("competition_publish_validation_failed");
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("lets staff publish a paid draft of a trusted owner with no host check", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      await plantPaidPrice(tx, draft);
      await plantInstitutionVerified(tx, workspace.institutionId);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");

      const pressed = await pressOn(tx, staff, workspace, draft);

      expect(pressed.status).toBe(200);
      expect(pressed.body.competition?.status).toBe("published");
      expect(await competitionStatusOf(tx, draft)).toBe("published");
      expect(await hostCheckRowsOf(tx, staff)).toEqual([]);
    });
  });

  it("lets staff unpublish a live competition and refuses an institution_member", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const ownerPress = await pressOn(tx, owner, workspace, draft);
      expect(ownerPress.status).toBe(200);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");
      const member = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, member, "institution_member");

      await expect(unpublishCompetition(member, draft, tx)).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
      });
      expect(await competitionStatusOf(tx, draft)).toBe("published");

      const unpublished = await unpublishCompetition(staff, draft, tx);

      expect(unpublished.cancelledCount).toBe(0);
      expect(unpublished.competition.status).toBe("draft");
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("refuses a press when the account has no name and phone to copy", async () => {
    await inRollback(async (tx) => {
      const host = await plantHostWithoutParticipantDetails(tx);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(422);
      expect(pressed.body.error?.code).toBe("host_check_contact_missing");
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("copies the name and phone of the newest earlier host request when the account has no participant details", async () => {
    await inRollback(async (tx) => {
      const host = await plantHostWithoutParticipantDetails(tx);
      await plantClosedRequestWithoutDraft(tx, host, "Budi Lama", "081211112222");
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await openHostChecksOf(tx, host)).toEqual([
        {
          competitionId: draft,
          status: "pending_review",
          fullName: "Budi Lama",
          mobileNumber: "081211112222",
        },
      ]);
    });
  });

  it("reads no host check needed for a trusted owner and for staff of a trusted owner", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");

      expect(await readinessOf(tx, owner, draft)).toEqual(NOT_NEEDED_READINESS);
      expect(await readinessOf(tx, staff, draft)).toEqual(NOT_NEEDED_READINESS);
    });
  });

  it("reads no host check needed for an older host its sign-in email would trust, and needed once staff removed its trust", async () => {
    await inRollback(async (tx) => {
      const host = await signUpLegacyHost(tx, "budi.lama@acme.example");
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      expect(await readinessOf(tx, host, draft)).toEqual(NOT_NEEDED_READINESS);
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await organizationEmailRowsOf(tx, host)).toEqual([]);

      await plantTrustRemoval(tx, host);

      expect(await readinessOf(tx, host, draft)).toEqual(NEEDED_READINESS);
    });
  });

  it("reads a host check needed for an untrusted host, then pending on the draft it sent", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      expect(await readinessOf(tx, host, draft)).toEqual(NEEDED_READINESS);

      const pressed = await pressOn(tx, host, workspace, draft);
      expect(pressed.status).toBe(202);

      expect(await readinessOf(tx, host, draft)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "pending" },
      });
    });
  });

  it("reads the title of the draft that waits for its host check on another draft", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const first = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      const second = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
      const pressed = await pressOn(tx, host, workspace, first);
      expect(pressed.status).toBe(202);

      expect(await readinessOf(tx, host, second)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "pending_other_draft", competitionTitle: FIRST_TITLE },
      });
    });
  });

  it("reads a closed host request without a draft as no turn-down, and a staff turn-down as turned down", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantClosedRequestWithoutDraft(tx, host, "Rina Pratama", "0812345678");
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      expect(await readinessOf(tx, host, draft)).toEqual(NEEDED_READINESS);

      await plantStaffTurnDown(tx, host, draft, new Date(Date.now() - 60_000));

      expect(await readinessOf(tx, host, draft)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: {
          state: "turned_down",
          guidelineItem: "kontak-nyata",
          note: "Nomor kontak tidak aktif.",
        },
      });
    });
  });

  it("keeps an earlier staff turn-down when a later host check closed because its draft went away", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const first = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      await plantStaffTurnDown(tx, host, first, new Date(Date.now() - 60_000));
      const firstPress = await pressOn(tx, host, workspace, first);
      expect(firstPress.status).toBe(202);
      await softDeleteCompetitionDraft(host, first, tx);
      const second = await createPublishableDraft(tx, host, workspace.slug, SECOND_TITLE);
      const secondPress = await pressOn(tx, host, workspace, second);
      expect(secondPress.status).toBe(202);
      await softDeleteCompetitionDraft(host, second, tx);
      const third = await createPublishableDraft(tx, host, workspace.slug, "Lomba Fotografi Alam");

      expect(await readinessOf(tx, host, third)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: {
          state: "turned_down",
          guidelineItem: "kontak-nyata",
          note: "Nomor kontak tidak aktif.",
        },
      });
    });
  });

  it("leaves every host check row of other accounts alone when a host presses publish, and reads none of them", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, TRUSTED_BY_SIGN_IN_EMAIL);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const goneDraft = await createPublishableDraft(
        tx,
        owner,
        ownerWorkspace.slug,
        "Lomba Fotografi Alam",
      );
      const liveDraft = await createPublishableDraft(tx, owner, ownerWorkspace.slug, SECOND_TITLE);
      await softDeleteCompetitionDraft(owner, goneDraft, tx);
      const withLegacy = await signUpParticipant(tx, "dina.lama@example.test");
      await plantOpenRequestWithoutDraft(tx, withLegacy);
      const withGone = await signUpParticipant(tx, "eko.lama@example.test");
      await plantOpenCheck(tx, withGone, goneDraft);
      const withLive = await signUpParticipant(tx, "fajar@example.test");
      await plantOpenCheck(tx, withLive, liveDraft);
      const withTurnDown = await signUpParticipant(tx, "gita@example.test");
      await plantStaffTurnDown(tx, withTurnDown, liveDraft, new Date("2099-01-01T00:00:00Z"));
      const others = [withLegacy, withGone, withLive, withTurnDown];
      const before = await submissionRowsOf(tx, others);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      expect(await readinessOf(tx, host, draft)).toEqual(NEEDED_READINESS);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await submissionRowsOf(tx, others)).toEqual(before);
      expect(await readinessOf(tx, host, draft)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "pending" },
      });
    });
  });

  it("names no draft of a workspace where the host was moved down to institution_member, in the refusal and in readiness", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const ownerWorkspace = await ownWorkspace(tx, owner);
      const theirs = await createPublishableDraft(tx, owner, ownerWorkspace.slug, FIRST_TITLE);
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const hostWorkspace = await ownWorkspace(tx, host);
      const mine = await createPublishableDraft(tx, host, hostWorkspace.slug, SECOND_TITLE);
      await plantMembership(tx, ownerWorkspace.institutionId, host, "institution_staff");
      const sent = await pressOn(tx, host, ownerWorkspace, theirs);
      expect(sent.status).toBe(202);
      const membershipId = await membershipIdOf(tx, ownerWorkspace.institutionId, host);
      await changeMemberRole(owner, ownerWorkspace.slug, membershipId, "institution_member", tx);

      const pressed = await pressOn(tx, host, hostWorkspace, mine);

      expect(pressed.status).toBe(409);
      expect(pressed.body.error?.code).toBe("host_check_pending_other_draft");
      expect(pressed.body.error?.details).toBeUndefined();
      expect(await readinessOf(tx, host, mine)).toEqual({
        canPublish: true,
        blockers: [],
        hostCheck: { state: "pending_other_draft" },
      });
    });
  });

  it("keeps an approved host request without a draft approved when the host presses publish", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const approvedId = await plantApprovedRequestWithoutDraft(tx, host);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await hostCheckRowOf(tx, approvedId)).toEqual({
        status: "approved",
        rejectionReason: null,
        guidelineItem: null,
        resubmissionAllowed: true,
        reviewedAt: expect.any(Date),
      });
    });
  });

  it("answers a draft without an organizer contact with the contact refusal and opens no host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createDraftMissing(tx, host, workspace.slug, FIRST_TITLE, "contact");

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(422);
      expect(pressed.body.error?.code).toBe("competition_organizer_contact_missing");
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
    });
  });

  it("answers a draft without an audience with the audience refusal and opens no host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createDraftMissing(tx, host, workspace.slug, FIRST_TITLE, "audience");

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(422);
      expect(pressed.body.error?.code).toBe("competition_audience_missing");
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
    });
  });

  it("sends untrusted staff on a paid draft of an untrusted owner to a host check", async () => {
    await inRollback(async (tx) => {
      const owner = await signUpHost(tx, SECOND_UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, owner);
      const draft = await createPublishableDraft(tx, owner, workspace.slug, FIRST_TITLE);
      await plantPaidPrice(tx, draft);
      await plantInstitutionVerified(tx, workspace.institutionId);
      const staff = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      await plantMembership(tx, workspace.institutionId, staff, "institution_staff");

      const pressed = await pressOn(tx, staff, workspace, draft);

      expect(pressed.status).toBe(202);
      expect(await openHostChecksOf(tx, staff)).toEqual([expectedOpenCheck(draft)]);
      expect(await competitionStatusOf(tx, draft)).toBe("draft");
    });
  });

  it("answers a team draft of a personal workspace with the personal refusal and opens no host check", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, UNTRUSTED_HOST_ADDRESS);
      const workspace = await ownWorkspace(tx, host);
      const draft = await createPublishableDraft(tx, host, workspace.slug, FIRST_TITLE);
      await plantTeamMode(tx, draft);

      const pressed = await pressOn(tx, host, workspace, draft);

      expect(pressed.status).toBe(422);
      expect(pressed.body.error?.code).toBe("competition_personal_individual_only");
      expect(await hostCheckRowsOf(tx, host)).toEqual([]);
    });
  });
});

const RACE_MARKER = "hostcheckrace";

let raceClient: postgres.Sql | null = null;

const raceDatabase = (): Database => drizzle(raceClient!, { schema }) as unknown as Database;

let raceSeedCounter = 0;
const nextRaceSeedId = (): string => `${Date.now().toString(36)}${raceSeedCounter++}`;

// Deletes every row any run of this file committed, matched by marker, so it also removes what a
// crashed run left behind. Drafts and memberships go with their workspace, and host checks and
// participant details with their account, by the foreign keys.
const sweepRaceRows = async (): Promise<void> => {
  if (!raceClient) return;
  await raceClient`delete from institutions where slug like ${`${RACE_MARKER}-%`}`;
  await raceClient`delete from users where username like ${`${RACE_MARKER}_%`}`;
};

const purgeRaceRowsOnSignal = () => {
  void sweepRaceRows().catch(() => undefined);
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(work: Promise<T>): Promise<Settled<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

// Planted directly and committed: an untrusted host with participant details, its workspace and one
// complete draft. Two connections cannot share a rolled-back transaction.
const seedRaceDraft = async (): Promise<{ hostId: string; competitionId: string }> => {
  const raceDb = raceDatabase();
  const id = nextRaceSeedId();
  const username = `${RACE_MARKER}_host_${id}`;
  const [host] = await raceDb
    .insert(schema.users)
    .values({
      email: `${username}@example.test`,
      username,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "minimal",
    })
    .returning({ id: schema.users.id });
  await raceDb.insert(schema.candidateProfiles).values({
    userId: host!.id,
    fullName: "Rina Pratama",
    phoneNumber: "0812345678",
    occupation: "college_student",
    dateOfBirth: "2000-01-15",
  });
  const [institution] = await raceDb
    .insert(schema.institutions)
    .values({
      slug: `${RACE_MARKER}-${id}`,
      institutionType: "company",
      displayName: "Race Fixture",
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: "pending_verification",
    })
    .returning({ id: schema.institutions.id });
  await raceDb.insert(schema.institutionMemberships).values({
    institutionId: institution!.id,
    userId: host!.id,
    membershipRole: "institution_owner",
    status: "active",
  });
  const [competition] = await raceDb
    .insert(schema.competitions)
    .values({
      institutionId: institution!.id,
      slug: "race-draft",
      title: "Lomba Esai Nasional",
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      location: "online",
      audience: ["umum"],
      status: "draft",
      organizerContactKind: "whatsapp",
      organizerContactValue: "6281298765432",
      ...validTimeline(),
    })
    .returning({ id: schema.competitions.id });
  return { hostId: host!.id, competitionId: competition!.id };
};

const countOpenHostChecksOf = async (userId: string): Promise<number> => {
  const sqlClient = raceClient!;
  const rows = await sqlClient<{ count: string }[]>`
    select count(*) as count from recruiter_verification_submissions
    where user_id = ${userId} and status in ('draft', 'pending_review')`;
  return Number(rows[0]!.count);
};

describe.skipIf(skipWithoutDatabase)(
  "the publish press under two presses at once (committed rows)",
  () => {
    beforeAll(async () => {
      raceClient = postgres(TEST_DATABASE_URL!, { max: 2 });
      await sweepRaceRows();
      process.on("SIGINT", purgeRaceRowsOnSignal);
      process.on("SIGTERM", purgeRaceRowsOnSignal);
    });

    // In afterEach so an assertion failing mid-test cannot skip the cleanup of committed rows.
    afterEach(async () => {
      await sweepRaceRows();
    });

    afterAll(async () => {
      process.off("SIGINT", purgeRaceRowsOnSignal);
      process.off("SIGTERM", purgeRaceRowsOnSignal);
      try {
        await sweepRaceRows();
        const users = await raceClient!<{ count: string }[]>`
          select count(*) as count from users where username like ${`${RACE_MARKER}_%`}`;
        const institutions = await raceClient!<{ count: string }[]>`
          select count(*) as count from institutions where slug like ${`${RACE_MARKER}-%`}`;
        expect(Number(users[0]!.count), "race accounts left behind").toBe(0);
        expect(Number(institutions[0]!.count), "race workspaces left behind").toBe(0);
      } finally {
        await raceClient?.end();
      }
    });

    it("gives two presses at once on one draft one host check and answers both with it", async () => {
      const { hostId, competitionId } = await seedRaceDraft();
      const raceDb = raceDatabase();

      const settled = await Promise.all([
        settle(publishOrOpenHostCheck(hostId, competitionId, raceDb)),
        settle(publishOrOpenHostCheck(hostId, competitionId, raceDb)),
      ]);

      expect(settled.map((outcome) => outcome.ok)).toEqual([true, true]);
      const hostCheckIds = settled.map((outcome) =>
        outcome.ok && outcome.value.outcome === "host_check_opened"
          ? outcome.value.hostCheck.id
          : null,
      );
      expect(hostCheckIds[0]).toEqual(expect.any(String));
      expect(hostCheckIds[1]).toBe(hostCheckIds[0]);
      expect(await countOpenHostChecksOf(hostId)).toBe(1);
    }, 60_000);
  },
);
