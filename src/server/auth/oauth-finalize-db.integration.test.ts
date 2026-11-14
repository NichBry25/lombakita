// @vitest-environment node

// A Google sign-up, driven against real rows in a rolled-back transaction. The carrier is signed by
// the real carrier module and redeemed through the real finalize entry, so these tests run the
// production path from the Google sign-in decision to the written account. The single-use store is
// an in-memory set with the same first-use-wins answer as the Redis one.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  consumedKeys: new Set<string>(),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: "test-google-finalize-secret",
      appBaseUrl: "http://localhost:3000",
    },
  };
});

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    consumeSingleUseToken: async (params: { key: string; ttlSeconds: number }) => {
      if (mocks.consumedKeys.has(params.key)) {
        return false;
      }
      mocks.consumedKeys.add(params.key);
      return true;
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { authorizeOAuthFinalize, resolveGoogleOAuthSignIn } from "@/server/auth/oauth-account";
import { signGoogleIdentityCarrier } from "@/server/auth/oauth-identity-carrier";

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
  mocks.consumedKeys.clear();
});

const CANDIDATE_FIELDS = {
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const newGoogleIdentity = () => {
  const suffix = randomUUID();
  return {
    email: `rina.google.${suffix}@example.test`,
    subject: `google-sub-${suffix}`,
  };
};

const carrierFor = (identity: { email: string; subject: string }, emailVerified: boolean): string =>
  signGoogleIdentityCarrier({
    provider: "google",
    providerAccountId: identity.subject,
    email: identity.email,
    emailVerified,
    name: "Rina Pratama",
    image: null,
  });

const userRowsWithEmail = (tx: Database, email: string) =>
  tx
    .select({
      id: schema.users.id,
      emailVerified: schema.users.emailVerified,
      role: schema.users.role,
      candidateVerifiedAt: schema.users.candidateVerifiedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email));

const accountRowsWithSubject = (tx: Database, subject: string) =>
  tx
    .select({ userId: schema.accounts.userId, provider: schema.accounts.provider })
    .from(schema.accounts)
    .where(eq(schema.accounts.providerAccountId, subject));

const candidateProfileRowsOf = (tx: Database, userId: string) =>
  tx
    .select({ fullName: schema.candidateProfiles.fullName })
    .from(schema.candidateProfiles)
    .where(eq(schema.candidateProfiles.userId, userId));

describe.skipIf(skipWithoutDatabase)("the Google sign-up against a real database", () => {
  it("finishes a Google sign-up whose address Google has verified, with the participant profile", async () => {
    await inRollback(async (tx) => {
      const identity = newGoogleIdentity();
      const carrier = carrierFor(identity, true);

      const finalized = await authorizeOAuthFinalize(
        { carrier, role: "candidate", ...CANDIDATE_FIELDS },
        tx,
      );

      expect(finalized.role).toBe("candidate");
      const [user] = await userRowsWithEmail(tx, identity.email);
      expect(user?.emailVerified).toBeInstanceOf(Date);
      expect(user?.role).toBe("candidate");
      expect(user?.candidateVerifiedAt).toBeInstanceOf(Date);
      const [account] = await accountRowsWithSubject(tx, identity.subject);
      expect(account?.provider).toBe("google");
      expect(account?.userId).toBe(user?.id);
      const [profile] = await candidateProfileRowsOf(tx, user?.id ?? "");
      expect(profile?.fullName).toBe("Rina Pratama");
    });
  });

  it("refuses to finish a Google sign-up whose address Google has not verified, writing no account", async () => {
    await inRollback(async (tx) => {
      const identity = newGoogleIdentity();
      const carrier = carrierFor(identity, false);

      await expect(
        authorizeOAuthFinalize({ carrier, role: "candidate", ...CANDIDATE_FIELDS }, tx),
      ).rejects.toMatchObject({ code: "email_unverified" });

      expect(await userRowsWithEmail(tx, identity.email)).toEqual([]);
      expect(await accountRowsWithSubject(tx, identity.subject)).toEqual([]);
    });
  });

  it("refuses a new Google sign-in whose address Google has not verified before any carrier is issued", async () => {
    await inRollback(async (tx) => {
      const identity = newGoogleIdentity();

      const outcome = await resolveGoogleOAuthSignIn(
        {
          providerAccountId: identity.subject,
          email: identity.email,
          googleEmailVerified: false,
          name: "Rina Pratama",
          image: null,
        },
        tx,
      );

      expect(outcome).toBe("http://localhost:3000/auth/login?error=oauth_email_unverified");
      expect(await userRowsWithEmail(tx, identity.email)).toEqual([]);
    });
  });

  it("still sends a new Google sign-in whose address Google has verified to the role picker", async () => {
    await inRollback(async (tx) => {
      const identity = newGoogleIdentity();

      const outcome = await resolveGoogleOAuthSignIn(
        {
          providerAccountId: identity.subject,
          email: identity.email,
          googleEmailVerified: true,
          name: "Rina Pratama",
          image: null,
        },
        tx,
      );

      expect(outcome).toEqual(expect.stringContaining("/auth/login?oauth="));
    });
  });

  it("still signs in an already linked Google account whatever Google reports", async () => {
    await inRollback(async (tx) => {
      const identity = newGoogleIdentity();
      const carrier = carrierFor(identity, true);
      await authorizeOAuthFinalize({ carrier, role: "candidate", ...CANDIDATE_FIELDS }, tx);

      const outcome = await resolveGoogleOAuthSignIn(
        {
          providerAccountId: identity.subject,
          email: identity.email,
          googleEmailVerified: false,
          name: "Rina Pratama",
          image: null,
        },
        tx,
      );

      expect(outcome).toBe(true);
    });
  });
});
