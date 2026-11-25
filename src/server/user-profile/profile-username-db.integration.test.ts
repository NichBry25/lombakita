// @vitest-environment node

// The username against the workspace slugs, against real rows in a rolled-back transaction. The host
// comes through the real sign-up and host step services and each username through the real profile
// service. The legacy personal workspace is planted, and its helper says why.

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

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueCompetitionSearchSync: vi.fn(async () => ({})),
  };
});

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";
import { updateOwnerProfile } from "@/server/user-profile/profile-service";

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
  vi.mocked(enqueueCompetitionSearchSync).mockClear();
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

const usernameOf = async (tx: Database, userId: string): Promise<string | undefined> => {
  const [row] = await tx
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.username;
};

const slugOf = async (tx: Database, institutionId: string): Promise<string | undefined> => {
  const [row] = await tx
    .select({ slug: schema.institutions.slug })
    .from(schema.institutions)
    .where(eq(schema.institutions.id, institutionId));
  return row?.slug;
};

const summaryOf = async (tx: Database, userId: string): Promise<string | null> => {
  const [row] = await tx
    .select({ summary: schema.userProfiles.summary })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId));
  return row?.summary ?? null;
};

// Planted directly: no production path writes a workspace whose slug equals its owner's username any
// more. It is the row the old personal path left and the name migration keeps.
const plantLegacyPersonalWorkspace = async (tx: Database, ownerId: string): Promise<string> => {
  const [institution] = await tx
    .insert(schema.institutions)
    .values({
      displayName: "uji_budi's Institution",
      slug: "uji-budi",
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      institutionType: "personal",
    })
    .returning({ id: schema.institutions.id });
  if (!institution) throw new Error("No institution row planted");

  await tx.insert(schema.institutionMemberships).values({
    institutionId: institution.id,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });
  return institution.id;
};

const legacyHostWithWorkspace = async (
  tx: Database,
): Promise<{ host: string; institutionId: string }> => {
  const host = await signUpHost(tx, "uji.budi@acme.example");
  await updateOwnerProfile(host, { username: "uji_budi" }, tx);
  const institutionId = await plantLegacyPersonalWorkspace(tx, host);
  return { host, institutionId };
};

describe.skipIf(skipWithoutDatabase)("the username and the workspace slugs (rolled back)", () => {
  it("a username change moves no slug", async () => {
    await inRollback(async (tx) => {
      const { host, institutionId } = await legacyHostWithWorkspace(tx);

      await updateOwnerProfile(host, { username: "uji_budi_ui" }, tx);

      expect(await usernameOf(tx, host)).toBe("uji_budi_ui");
      expect(await slugOf(tx, institutionId)).toBe("uji-budi");
      expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    });
  });

  it("a username equal to the user's own workspace slug is refused", async () => {
    await inRollback(async (tx) => {
      const { host, institutionId } = await legacyHostWithWorkspace(tx);
      await updateOwnerProfile(host, { username: "uji_budi_ui" }, tx);

      await expect(updateOwnerProfile(host, { username: "uji_budi" }, tx)).rejects.toMatchObject({
        code: "profile_username_conflicts_with_institution",
      });

      expect(await usernameOf(tx, host)).toBe("uji_budi_ui");
      expect(await slugOf(tx, institutionId)).toBe("uji-budi");
    });
  });

  it("a legacy personal host saves the profile with an unchanged username", async () => {
    await inRollback(async (tx) => {
      const { host } = await legacyHostWithWorkspace(tx);

      await expect(
        updateOwnerProfile(host, { username: "uji_budi", bio: "x" }, tx),
      ).resolves.toBeDefined();

      expect(await usernameOf(tx, host)).toBe("uji_budi");
      expect(await summaryOf(tx, host)).toBe("x");
    });
  });
});
