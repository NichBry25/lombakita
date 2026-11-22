// @vitest-environment node

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { getPublicProfile } from "@/server/user-profile/profile-service";

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

type AccountOverrides = {
  emailVerified?: Date | null;
  recruiterVerifiedAt?: Date | null;
  recruiterVerificationTier?: "unverified" | "minimal" | "elevated";
};

const createAccount = async (tx: Database, overrides: AccountOverrides = {}) => {
  const suffix = crypto.randomUUID();
  const [account] = await tx
    .insert(schema.users)
    .values({
      email: `${suffix}@example.test`,
      username: `pp-${suffix}`,
      name: "Siti Aminah",
      role: "candidate",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: overrides.recruiterVerifiedAt ?? null,
      recruiterVerificationTier: overrides.recruiterVerificationTier ?? "unverified",
      emailVerified: overrides.emailVerified === undefined ? new Date() : overrides.emailVerified,
    })
    .returning({ id: schema.users.id, username: schema.users.username });
  if (!account) throw new Error("Account fixture was not inserted");

  return account as { id: string; username: string };
};

describe.skipIf(skipWithoutDatabase)("getPublicProfile and email verification", () => {
  it("does not show the public profile of an account whose email is not verified", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, { emailVerified: null });

      const profile = await getPublicProfile(account.username, tx);

      expect(profile).toBeNull();
    });
  });

  it("shows the public profile of an account whose email is verified", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, { emailVerified: new Date() });

      const profile = await getPublicProfile(account.username, tx);

      expect(profile?.username).toBe(account.username);
    });
  });

  it("calls a recruiter awaiting approval unverified in the public data", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, {
        emailVerified: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "minimal",
      });

      const profile = await getPublicProfile(account.username, tx);

      expect(profile?.recruiterVerified).toBe(false);
      expect(profile?.trustedRecruiter).toBe(false);
    });
  });

  it("calls an approved recruiter verified in the public data", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, {
        emailVerified: new Date(),
        recruiterVerifiedAt: new Date(),
        recruiterVerificationTier: "elevated",
      });

      const profile = await getPublicProfile(account.username, tx);

      expect(profile?.recruiterVerified).toBe(true);
      expect(profile?.trustedRecruiter).toBe(true);
    });
  });
});
