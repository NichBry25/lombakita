// @vitest-environment node

// A personal workspace's own logo and organizer profile against real rows in a rolled-back
// transaction. The host comes through the real sign-up, code verification and host step services,
// the host's avatar through the real profile file service, the workspace through the real create
// service, and the logo and the profile through the real media and profile services. Storage is
// stubbed at the R2 client, so the services sign and record keys with no bucket.

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

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  createInstitutionWorkspaceForUser,
  getInstitutionProfileForOwnerBySlug,
  listUserInstitutionMemberships,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  generateInstitutionMediaUploadUrl,
  recordInstitutionMedia,
} from "@/server/institution-workspace/institution-media-service";
import { generateAvatarUploadUrl, recordAvatar } from "@/server/user-profile/profile-files-service";

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

const institutionRowBySlug = async (tx: Database, slug: string) => {
  const [row] = await tx
    .select({
      logoR2Key: schema.institutions.logoR2Key,
      bannerR2Key: schema.institutions.bannerR2Key,
      about: schema.institutions.about,
      contactEmail: schema.institutions.contactEmail,
    })
    .from(schema.institutions)
    .where(eq(schema.institutions.slug, slug));
  if (!row) throw new Error("No institution row");
  return row;
};

const avatarKeyOf = async (tx: Database, userId: string): Promise<string | null> => {
  const [row] = await tx
    .select({ avatarR2Key: schema.userProfiles.avatarR2Key })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId));
  if (!row) throw new Error("No profile row");
  return row.avatarR2Key;
};

describe.skipIf(skipWithoutDatabase)(
  "a personal workspace's own images and organizer profile (rolled back)",
  () => {
    it("shows only a logo uploaded to the workspace, never the avatar of its owner", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, "uji.logo@acme.example");
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
          { displayName: "Ruang Uji Logo", institutionType: "personal" },
          tx,
        );

        const profile = await getInstitutionProfileForOwnerBySlug(host, "ruang-uji-logo", tx);
        const memberships = await listUserInstitutionMemberships(host, tx);

        expect(await avatarKeyOf(tx, host)).toBe(avatarGrant.fileKey);
        expect(workspace.slug).toBe("ruang-uji-logo");
        expect(profile.logoUrl).toBeNull();
        expect(profile.bannerUrl).toBeNull();
        expect(memberships).toHaveLength(1);
        expect(memberships[0]!.logoUrl).toBeNull();
        expect(memberships[0]!.bannerUrl).toBeNull();

        const logoGrant = await generateInstitutionMediaUploadUrl(
          host,
          "ruang-uji-logo",
          "logo",
          { contentType: "image/png" },
          tx,
        );
        await recordInstitutionMedia(host, "ruang-uji-logo", "logo", logoGrant.fileKey, tx);
        const profileAfter = await getInstitutionProfileForOwnerBySlug(host, "ruang-uji-logo", tx);
        const membershipsAfter = await listUserInstitutionMemberships(host, tx);

        expect(logoGrant.fileKey.startsWith(`institution-logos/${workspace.institutionId}/`)).toBe(
          true,
        );
        expect((await institutionRowBySlug(tx, "ruang-uji-logo")).logoR2Key).toBe(
          logoGrant.fileKey,
        );
        expect(profileAfter.logoUrl).toBe(`https://signed.example/get/${logoGrant.fileKey}`);
        expect(profileAfter.bannerUrl).toBeNull();
        expect(membershipsAfter[0]!.logoUrl).toBe(
          `https://signed.example/get/${logoGrant.fileKey}`,
        );
        expect(membershipsAfter[0]!.bannerUrl).toBeNull();
      });
    });

    it("lets the owner of a personal workspace edit its organizer profile", async () => {
      await inRollback(async (tx) => {
        const host = await signUpHost(tx, "uji.profil@acme.example");
        await createInstitutionWorkspaceForUser(
          host,
          { displayName: "Ruang Uji Profil", institutionType: "personal" },
          tx,
        );

        const before = await getInstitutionProfileForOwnerBySlug(host, "ruang-uji-profil", tx);

        expect(before.isEditable).toBe(true);
        expect(before.about).toBeNull();
        expect(before.contactEmail).toBeNull();

        const updated = await updateInstitutionProfileForOwnerBySlug(
          host,
          "ruang-uji-profil",
          { about: "Komunitas lomba menulis untuk pelajar.", contactEmail: "panitia@acme.example" },
          tx,
        );

        expect(updated.about).toBe("Komunitas lomba menulis untuk pelajar.");
        expect(updated.contactEmail).toBe("panitia@acme.example");
        expect(updated.isEditable).toBe(true);
        expect(updated.socialLinks).toEqual([]);
        const row = await institutionRowBySlug(tx, "ruang-uji-profil");
        expect(row.about).toBe("Komunitas lomba menulis untuk pelajar.");
        expect(row.contactEmail).toBe("panitia@acme.example");
      });
    });
  },
);
