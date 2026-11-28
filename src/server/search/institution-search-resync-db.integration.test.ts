// @vitest-environment node

// The search resync of an owner's name or slug change against real rows. Accounts come through the
// real sign-up, code verification and host step services, the Email organisasi through its real code
// services, workspaces and competitions through their services, and the change through the real
// settings route handler with the Rule 16 header.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, asc, eq } from "drizzle-orm";
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
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "@/server/host-trust/organization-email-service";
import {
  createCompetitionDraft,
  softDeleteCompetitionDraft,
  transitionCompetitionStatus,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { tickByOrganizationDomain } from "@/server/institution-verification/tick-service";
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

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  routeState.transaction = null;
  routeState.actorUserId = null;
  searchSpy().mockClear();
});

// ── Accounts and workspaces ──────────────────────────────────────────────────────────────────

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

// Confirms an Email organisasi through the real code services, which also trusts the account.
const confirmOrganizationEmail = async (
  tx: Database,
  userId: string,
  address: string,
): Promise<void> => {
  await issueOrganizationEmailCode(userId, address, tx);
  await confirmOrganizationEmailCode(userId, latestOrganizationCodeFor(address), tx);
};

type Owner = { institutionId: string; slug: string; ownerId: string };

// The owner signed up and took the host step, confirmed an Email organisasi (which trusts the
// account), created the workspace and saved its website.
const buildTickOwner = async (tx: Database): Promise<Owner> => {
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
  const owner = await buildTickOwner(tx);
  await tickByOrganizationDomain(owner.ownerId, owner.slug, tx);
  return owner;
};

// ── Competitions ─────────────────────────────────────────────────────────────────────────────

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

// The workspace's published, draft and soft-deleted competitions, built through the services.
const buildThreeCompetitions = async (tx: Database, owner: Owner): Promise<string[]> => {
  const publishedId = await createPublishableDraft(tx, owner, `Terbit ${freshPart()}`);
  await transitionCompetitionStatus(owner.ownerId, publishedId, "published", tx);
  const draftId = await createPublishableDraft(tx, owner, `Draf ${freshPart()}`);
  const deletedId = await createPublishableDraft(tx, owner, `Dihapus ${freshPart()}`);
  await softDeleteCompetitionDraft(owner.ownerId, deletedId, tx);
  return [publishedId, draftId, deletedId];
};

// ── Route calls ──────────────────────────────────────────────────────────────────────────────

const patchSettings = async (
  tx: Database,
  actorUserId: string,
  slug: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { error?: { code: string } } }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  const response = await settingsRoute(
    new Request(`http://localhost/api/v1/institutions/${slug}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: actorUserId },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ institutionSlug: slug }) },
  );
  return { status: response.status, body: await response.json() };
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

const auditRowCountsOf = async (tx: Database, institutionId: string) => {
  const verification = await tx
    .select({ id: schema.institutionVerificationAudit.id })
    .from(schema.institutionVerificationAudit)
    .where(eq(schema.institutionVerificationAudit.institutionId, institutionId))
    .orderBy(asc(schema.institutionVerificationAudit.id));
  const platform = await tx
    .select({ id: schema.platformOpsAuditLogs.id })
    .from(schema.platformOpsAuditLogs)
    .where(eq(schema.platformOpsAuditLogs.targetInstitutionId, institutionId));
  return { verification: verification.length, platform: platform.length };
};

// "No row change": the name, the address, the status, the five tick columns and the audit rows of
// both logs.
const snapshotOf = async (tx: Database, institutionId: string) => ({
  workspace: await readWorkspace(tx, institutionId),
  auditRows: await auditRowCountsOf(tx, institutionId),
});

const searchCalls = () => searchSpy().mock.calls.map(([call]) => call);

const upsertOf = (competitionId: string) => ({ competitionId, action: "upsert" });

describe.skipIf(skipWithoutDatabase)("the search resync of an owner's settings change", () => {
  it("an owner's slug change resyncs every competition of the workspace", async () => {
    await inRollback(async (tx) => {
      const owner = await buildTickOwner(tx);
      const competitionIds = await buildThreeCompetitions(tx, owner);
      searchSpy().mockClear();

      const newSlug = `ruang-baru-${freshPart()}`;
      const changed = await patchSettings(tx, owner.ownerId, owner.slug, { slug: newSlug });

      expect(changed.status).toBe(200);
      expect((await readWorkspace(tx, owner.institutionId)).slug).toBe(newSlug);
      expect(searchCalls()).toHaveLength(3);
      expect(searchCalls()).toEqual(expect.arrayContaining(competitionIds.map(upsertOf)));

      searchSpy().mockClear();
      const describedOnly = await patchSettings(tx, owner.ownerId, newSlug, {
        description: "Deskripsi baru untuk pengujian.",
      });

      expect(describedOnly.status).toBe(200);
      expect(searchSpy()).not.toHaveBeenCalled();
    });
  });

  it("an owner's name change resyncs too", async () => {
    await inRollback(async (tx) => {
      const owner = await buildPathATick(tx);
      const competitionIds = await buildThreeCompetitions(tx, owner);
      searchSpy().mockClear();
      const before = await snapshotOf(tx, owner.institutionId);
      const newName = `Nama Baru ${freshPart()}`;

      const unconfirmed = await patchSettings(tx, owner.ownerId, owner.slug, {
        displayName: newName,
      });

      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body.error?.code).toBe("institution_tick_removal_unconfirmed");
      expect(await snapshotOf(tx, owner.institutionId)).toEqual(before);
      expect(searchSpy()).not.toHaveBeenCalled();

      const confirmed = await patchSettings(tx, owner.ownerId, owner.slug, {
        displayName: newName,
        acknowledgeTickRemoval: true,
      });

      expect(confirmed.status).toBe(200);
      const after = await readWorkspace(tx, owner.institutionId);
      expect(after.displayName).toBe(newName);
      expect(after.verificationStatus).toBe("pending_verification");
      expect(after.tickPath).toBeNull();
      expect(after.tickDomain).toBeNull();
      expect(after.nameCheckedAt).toBeNull();
      expect(after.nameProofDueAt).toBeNull();
      expect(after.nameProofRemindedAt).toBeNull();
      expect(searchCalls()).toHaveLength(3);
      expect(searchCalls()).toEqual(expect.arrayContaining(competitionIds.map(upsertOf)));
    });
  });
});
