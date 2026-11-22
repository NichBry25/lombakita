// @vitest-environment node

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { hashPassword } from "@/server/auth/password";
import { registerUserWithCredentials } from "@/server/auth/credentials-auth";

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

const FIRST_PASSWORD = "first-password-1";

type AccountOverrides = {
  emailVerified?: Date | null;
};

const createAccount = async (tx: Database, overrides: AccountOverrides = {}) => {
  const suffix = crypto.randomUUID();
  const [account] = await tx
    .insert(schema.users)
    .values({
      email: `${suffix}@example.test`,
      username: `reg-${suffix}`,
      name: "Siti Aminah",
      role: "candidate",
      candidateVerifiedAt: new Date(),
      emailVerified: overrides.emailVerified === undefined ? new Date() : overrides.emailVerified,
    })
    .returning({ id: schema.users.id, email: schema.users.email });
  if (!account) throw new Error("Account fixture was not inserted");

  await tx.insert(schema.userPasswordCredentials).values({
    userId: account.id,
    passwordHash: await hashPassword(FIRST_PASSWORD),
  });

  return account as { id: string; email: string };
};

const recruiterSignupFor = (email: string) => ({
  name: "Dinda Recruiter",
  email,
  password: "very-strong-password",
  signupRole: "recruiter",
  fullName: "Dinda Recruiter",
  mobileNumber: "0812345678",
  corporateEmail: "dinda@seed.lombakita.local",
});

const readStoredAccount = async (tx: Database, userId: string) => {
  const [user] = await tx
    .select({
      name: schema.users.name,
      username: schema.users.username,
      role: schema.users.role,
      candidateVerifiedAt: schema.users.candidateVerifiedAt,
      recruiterVerifiedAt: schema.users.recruiterVerifiedAt,
      recruiterVerificationTier: schema.users.recruiterVerificationTier,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const [password] = await tx
    .select({ passwordHash: schema.userPasswordCredentials.passwordHash })
    .from(schema.userPasswordCredentials)
    .where(eq(schema.userPasswordCredentials.userId, userId));
  const candidateProfileRows = await tx
    .select({ userId: schema.candidateProfiles.userId })
    .from(schema.candidateProfiles)
    .where(eq(schema.candidateProfiles.userId, userId));
  const recruiterSubmissionRows = await tx
    .select({ id: schema.recruiterVerificationSubmissions.id })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.userId, userId));
  const verificationTokenRows = await tx
    .select({ id: schema.userEmailVerificationTokens.id })
    .from(schema.userEmailVerificationTokens)
    .where(eq(schema.userEmailVerificationTokens.userId, userId));

  return {
    user,
    passwordHash: password?.passwordHash,
    candidateProfileCount: candidateProfileRows.length,
    recruiterSubmissionCount: recruiterSubmissionRows.length,
    verificationTokenCount: verificationTokenRows.length,
  };
};

describe.skipIf(skipWithoutDatabase)(
  "a second sign-up for an existing email, against a real database",
  () => {
    it("refuses a sign-up for a verified email and changes nothing", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx, { emailVerified: new Date() });
        const before = await readStoredAccount(tx, account.id);
        expect(before.user).toBeDefined();
        expect(before.passwordHash).toBeDefined();

        await expect(
          registerUserWithCredentials(recruiterSignupFor(account.email), tx),
        ).rejects.toMatchObject({ code: "email_exists" });

        const after = await readStoredAccount(tx, account.id);
        expect(after).toEqual(before);
      });
    });

    it("refuses a sign-up for a never-verified email and changes nothing", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx, { emailVerified: null });
        const before = await readStoredAccount(tx, account.id);
        expect(before.user).toBeDefined();
        expect(before.passwordHash).toBeDefined();

        await expect(
          registerUserWithCredentials(recruiterSignupFor(account.email), tx),
        ).rejects.toMatchObject({ code: "email_not_verified" });

        const after = await readStoredAccount(tx, account.id);
        expect(after).toEqual(before);
      });
    });
  },
);
