// @vitest-environment node

// The stored name of a personal workspace on every surface that shows it, and its own logo on the
// public pages, against real rows in a rolled-back transaction. Hosts and participants come through
// the real sign-up, code verification and host step services, the workspace through the real create
// service, the competition through the real draft and publish services, and the save, the
// invitation, the avatar, the logo and the username change through their real services. Storage is
// stubbed at the R2 client and the queue at the enqueue module, so nothing leaves the process.

import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
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

vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return {
    ...actual,
    isR2Available: () => true,
    generatePresignedPutUrl: vi.fn(async (key: string) => `https://signed.example/put/${key}`),
    generatePresignedGetUrl: vi.fn(async (key: string) => `https://signed.example/get/${key}`),
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueCompetitionSearchSync: vi.fn(async () => ({})),
    enqueueCompetitionCancelled: vi.fn(async () => ({})),
    enqueueRegistrationConfirmed: vi.fn(async () => ({})),
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
  };
});

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createInstitutionWorkspaceForUser,
  getInstitutionWorkspaceForOwnerBySlug,
  listUserInstitutionMemberships,
  loadInstitutionVerificationSummaryBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  generateInstitutionMediaUploadUrl,
  recordInstitutionMedia,
} from "@/server/institution-workspace/institution-media-service";
import {
  ANONYMOUS_INSTITUTION_VIEWER,
  getPublicInstitution,
} from "@/server/institution-workspace/institution-public-service";
import { generateAvatarUploadUrl, recordAvatar } from "@/server/user-profile/profile-files-service";
import { updateOwnerProfile } from "@/server/user-profile/profile-service";
import {
  createCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { setCompetitionEligibilityForEditor } from "@/server/competitions/competition-eligibility-service";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { publishOrOpenHostCheck } from "@/server/host-trust/host-check-service";
import {
  getPublicCompetitionDetail,
  listPublicCompetitions,
} from "@/server/competitions/competition-public-service";
import {
  COMPETITION_INDEX_COLUMNS,
  toCompetitionIndexDocument,
} from "@/server/search/competition-index-documents";
import {
  listSavedCompetitions,
  saveCompetition,
} from "@/server/saved-competitions/saved-competition-service";
import { createInstitutionInvitation } from "@/server/institution-invitations/invitation-service";
import { listUserInbox } from "@/server/notifications/inbox-service";
import {
  lookupInstitutionBySlug,
  lookupInstitutionBySlugOrName,
} from "@/server/moderation/lookup-service";

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

const avatarKeyOf = async (tx: Database, userId: string): Promise<string | null> => {
  const [row] = await tx
    .select({ avatarR2Key: schema.userProfiles.avatarR2Key })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId));
  if (!row) throw new Error("No profile row");
  return row.avatarR2Key;
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

const competitionSlugOf = async (tx: Database, competitionId: string): Promise<string> => {
  const [row] = await tx
    .select({ slug: schema.competitions.slug })
    .from(schema.competitions)
    .where(eq(schema.competitions.id, competitionId));
  if (!row) throw new Error("No competition row");
  return row.slug;
};

// The column set and the mapping the sync job uses, read on the test's transaction because the job
// reads the pool.
const searchDocumentOf = async (tx: Database, competitionId: string) => {
  const [row] = await tx
    .select(COMPETITION_INDEX_COLUMNS)
    .from(schema.competitions)
    .innerJoin(schema.institutions, eq(schema.institutions.id, schema.competitions.institutionId))
    .where(eq(schema.competitions.id, competitionId))
    .limit(1);
  if (!row) throw new Error("No competition row");
  return toCompetitionIndexDocument(row);
};

type SurfaceTargets = {
  ownerId: string;
  candidateId: string;
  inviteeId: string;
  slug: string;
  competitionId: string;
  competitionSlug: string;
};

const namesSeenFor = async (tx: Database, targets: SurfaceTargets) => {
  const listing = await listPublicCompetitions({ institutionSlug: targets.slug }, tx);
  const detail = await getPublicCompetitionDetail(targets.slug, targets.competitionSlug, tx);
  const searchDocument = await searchDocumentOf(tx, targets.competitionId);
  const saved = await listSavedCompetitions(targets.candidateId, {}, tx);
  const inbox = await listUserInbox(targets.inviteeId, tx);
  const operatorLookup = await lookupInstitutionBySlug(targets.slug, tx);
  const memberships = await listUserInstitutionMemberships(targets.ownerId, tx);
  const workspaceShell = await getInstitutionWorkspaceForOwnerBySlug(
    targets.ownerId,
    targets.slug,
    tx,
  );
  const verificationSummary = await loadInstitutionVerificationSummaryBySlug(targets.slug, tx);
  const publicPage = await getPublicInstitution(targets.slug, ANONYMOUS_INSTITUTION_VIEWER, tx);

  const inviteNames = inbox.flatMap((item) =>
    item.kind === "institution_invite" ? [item.institutionName] : [],
  );
  const dashboardEntry = memberships.find((membership) => membership.slug === targets.slug);

  return {
    listing: listing.data[0]?.institutionName,
    detail: detail?.organizer.name,
    searchDocument: searchDocument.institutionName,
    saved: saved.data[0]?.institutionName,
    inbox: inviteNames[0],
    operatorLookup: operatorLookup?.name,
    dashboard: dashboardEntry?.displayName,
    workspaceShell: workspaceShell.displayName,
    verificationSummary: verificationSummary?.displayName,
    publicPage: publicPage?.name,
  };
};

const logosSeenFor = async (tx: Database, slug: string, competitionSlug: string) => {
  const listing = await listPublicCompetitions({ institutionSlug: slug }, tx);
  const detail = await getPublicCompetitionDetail(slug, competitionSlug, tx);
  const publicPage = await getPublicInstitution(slug, ANONYMOUS_INSTITUTION_VIEWER, tx);

  return {
    listing: listing.data[0]?.institutionLogoUrl,
    detail: detail?.organizer.logoUrl,
    publicPage: publicPage?.logoUrl,
  };
};

describe.skipIf(skipWithoutDatabase)(
  "a personal workspace's stored name and own logo on every surface (rolled back)",
  () => {
    it("shows a personal workspace's stored name on every surface and keeps it when the owner changes username", async () => {
      await inRollback(async (tx) => {
        const owner = await signUpHost(tx, "budi.nama@acme.example");
        const candidateId = await signUpParticipant(tx, "sari.simpan@acme.example");
        const inviteeId = await signUpParticipant(tx, "dina.undangan@acme.example");
        const workspace = await createInstitutionWorkspaceForUser(
          owner,
          { displayName: "Lomba Budi", institutionType: "personal" },
          tx,
        );
        const competitionId = await createPublishableDraft(
          tx,
          owner,
          workspace.slug,
          "Lomba Esai Budi",
        );
        const pressed = await publishOrOpenHostCheck(owner, competitionId, tx);
        const competitionSlug = await competitionSlugOf(tx, competitionId);
        await saveCompetition(candidateId, competitionId, tx);
        await createInstitutionInvitation(
          owner,
          workspace.slug,
          { invitedIdentifier: "dina.undangan@acme.example", invitedRole: "institution_staff" },
          tx,
        );
        const targets: SurfaceTargets = {
          ownerId: owner,
          candidateId,
          inviteeId,
          slug: workspace.slug,
          competitionId,
          competitionSlug,
        };

        const before = await namesSeenFor(tx, targets);
        const newUsername = `budi_ganti_${owner.slice(0, 8)}`;
        const profile = await updateOwnerProfile(owner, { username: newUsername }, tx);
        const after = await namesSeenFor(tx, targets);

        const everySurfaceReadsTheStoredName = {
          listing: "Lomba Budi",
          detail: "Lomba Budi",
          searchDocument: "Lomba Budi",
          saved: "Lomba Budi",
          inbox: "Lomba Budi",
          operatorLookup: "Lomba Budi",
          dashboard: "Lomba Budi",
          workspaceShell: "Lomba Budi",
          verificationSummary: "Lomba Budi",
          publicPage: "Lomba Budi",
        };
        expect(pressed.outcome).toBe("published");
        expect(before).toEqual(everySurfaceReadsTheStoredName);
        expect(profile.username).toBe(newUsername);
        expect(after).toEqual(everySurfaceReadsTheStoredName);
      });
    });

    it("finds a personal workspace by its stored name in the operator lookup", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, "budi.cari@acme.example");
        const workspace = await createInstitutionWorkspaceForUser(
          host,
          { displayName: "Lomba Budi", institutionType: "personal" },
          tx,
        );

        const found = await lookupInstitutionBySlugOrName("lomba budi", tx);

        expect(found?.id).toBe(workspace.institutionId);
        expect(found?.name).toBe("Lomba Budi");
        expect(found?.slug).toBe(workspace.slug);
      });
    });

    it("shows only the logo uploaded to a personal workspace on the listing, the detail and the public page", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, "uji.logo.publik@acme.example");
        const avatarGrant = await generateAvatarUploadUrl(host, {
          fileName: "foto.png",
          mimeType: "image/png",
        });
        await recordAvatar(
          host,
          {
            fileKey: avatarGrant.fileKey,
            fileName: "foto.png",
            sizeBytes: 2048,
            mimeType: "image/png",
          },
          tx,
        );
        const workspace = await createInstitutionWorkspaceForUser(
          host,
          { displayName: "Ruang Logo Publik", institutionType: "personal" },
          tx,
        );
        const competitionId = await createPublishableDraft(
          tx,
          host,
          workspace.slug,
          "Lomba Logo Publik",
        );
        const pressed = await publishOrOpenHostCheck(host, competitionId, tx);
        const competitionSlug = await competitionSlugOf(tx, competitionId);

        const before = await logosSeenFor(tx, workspace.slug, competitionSlug);
        const logoGrant = await generateInstitutionMediaUploadUrl(
          host,
          workspace.slug,
          "logo",
          { contentType: "image/png" },
          tx,
        );
        await recordInstitutionMedia(host, workspace.slug, "logo", logoGrant.fileKey, tx);
        const after = await logosSeenFor(tx, workspace.slug, competitionSlug);

        const signedLogoAddress = `https://signed.example/get/${logoGrant.fileKey}`;
        expect(await avatarKeyOf(tx, host)).toBe(avatarGrant.fileKey);
        expect(pressed.outcome).toBe("published");
        expect(before).toEqual({ listing: null, detail: null, publicPage: null });
        expect(after).toEqual({
          listing: signedLogoAddress,
          detail: signedLogoAddress,
          publicPage: signedLogoAddress,
        });
      });
    });
  },
);
