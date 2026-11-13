// @vitest-environment node

// Verifying an address by code, driven against real rows in a rolled-back transaction. The code is
// taken from the real service at its real email boundary, so every test below runs the production
// path from sign-up to verification. The guessing limiter is an in-memory fixed window with the same
// count-then-compare order as the Redis one, so the limits are measured, not assumed.

import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  limiterMode: { current: "counting" as "counting" | "unavailable" },
  unavailableKeyPrefix: { current: null as string | null },
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
      if (mocks.limiterMode.current === "unavailable") {
        return { decision: "unavailable" as const };
      }
      const prefix = mocks.unavailableKeyPrefix.current;
      if (prefix !== null && params.key.startsWith(prefix)) {
        return { decision: "unavailable" as const };
      }
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

import {
  CredentialsAuthError,
  authenticateWithEmailPassword,
  registerUserWithCredentials,
  resendRegistrationVerification,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { elevateRecruiterTier } from "@/server/recruiter-tier/recruiter-tier-service";
import {
  listRecruiterVerificationQueue,
  reviewRecruiterVerification,
} from "@/server/recruiter-verification/recruiter-verification-service";

const ADDRESS = "rina.code@example.test";
const STRANGER_PASSWORD = "stranger-pass-1";
const OWNER_PASSWORD = "owner-pass-2";
const PASSWORD = "fresh-pass-3";

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
  mocks.limiterMode.current = "counting";
  mocks.unavailableKeyPrefix.current = null;
});

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const signUp = (tx: Database, password: string) =>
  registerUserWithCredentials({ ...CANDIDATE_DETAILS, email: ADDRESS, password }, tx);

const signUpAsHost = (tx: Database, password: string) =>
  registerUserWithCredentials(
    {
      name: "Budi Santoso",
      email: ADDRESS,
      password,
      signupRole: "recruiter",
      fullName: "Budi Santoso",
      mobileNumber: "081298765432",
      corporateEmail: null,
    },
    tx,
  );

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const wrongCodeFor = (code: string): string => (code === "000000" ? "000001" : "000000");

const verify = (
  tx: Database,
  code: string,
  password: string,
  details: Record<string, unknown> = CANDIDATE_DETAILS,
) => verifyEmailCodeAndSetPassword({ ...details, email: ADDRESS, code, password }, tx);

const accountOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ name: schema.users.name, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row;
};

const displayNameOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ displayName: schema.userProfiles.displayName })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId));
  if (!row) throw new Error("No user profile row");
  return row.displayName;
};

const candidateProfileOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({
      fullName: schema.candidateProfiles.fullName,
      phoneNumber: schema.candidateProfiles.phoneNumber,
      occupation: schema.candidateProfiles.occupation,
      dateOfBirth: schema.candidateProfiles.dateOfBirth,
    })
    .from(schema.candidateProfiles)
    .where(eq(schema.candidateProfiles.userId, userId));
  return row ?? null;
};

const hostRequestsOf = (tx: Database, userId: string) =>
  tx
    .select({
      id: schema.recruiterVerificationSubmissions.id,
      status: schema.recruiterVerificationSubmissions.status,
      mobileNumber: schema.recruiterVerificationSubmissions.mobileNumber,
      fullName: schema.recruiterVerificationSubmissions.fullName,
    })
    .from(schema.recruiterVerificationSubmissions)
    .where(eq(schema.recruiterVerificationSubmissions.userId, userId));

const limiterKeysCounted = (): string[] => [...mocks.windowCounts.keys()];

const userOf = async (tx: Database) => {
  const [row] = await tx
    .select({
      id: schema.users.id,
      emailVerified: schema.users.emailVerified,
      sessionsInvalidBefore: schema.users.sessionsInvalidBefore,
    })
    .from(schema.users)
    .where(eq(schema.users.email, ADDRESS));
  if (!row) throw new Error("No user row");
  return row;
};

const roleColumnsOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({
      role: schema.users.role,
      candidateVerifiedAt: schema.users.candidateVerifiedAt,
      recruiterVerifiedAt: schema.users.recruiterVerifiedAt,
      recruiterVerificationTier: schema.users.recruiterVerificationTier,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row;
};

const storedPasswordHashOf = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ hash: schema.userPasswordCredentials.passwordHash })
    .from(schema.userPasswordCredentials)
    .where(eq(schema.userPasswordCredentials.userId, userId));
  if (!row) throw new Error("No credential row");
  return row.hash;
};

const newestCodeRowOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select()
    .from(schema.userEmailVerificationTokens)
    .where(eq(schema.userEmailVerificationTokens.userId, userId))
    .orderBy(desc(schema.userEmailVerificationTokens.createdAt))
    .limit(1);
  if (!row) throw new Error("No code row");
  return row;
};

const seedPendingInvitation = async (tx: Database): Promise<string> => {
  const suffix = randomUUID();
  const institutionId = randomUUID();
  await tx.insert(schema.institutions).values({
    id: institutionId,
    slug: `code-${suffix}`,
    institutionType: "company",
    displayName: "Seed Academy",
    status: "active",
  });

  const invitationId = randomUUID();
  await tx.insert(schema.institutionInvitations).values({
    id: invitationId,
    institutionId,
    invitedEmail: ADDRESS,
    invitedRole: "institution_staff",
    tokenHash: `hash-${suffix}`,
    status: "pending_claim",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });

  return invitationId;
};

const invitationOf = async (tx: Database, invitationId: string) => {
  const [row] = await tx
    .select({
      status: schema.institutionInvitations.status,
      targetUserId: schema.institutionInvitations.targetUserId,
    })
    .from(schema.institutionInvitations)
    .where(eq(schema.institutionInvitations.id, invitationId));
  if (!row) throw new Error("No invitation row");
  return row;
};

const seedOperator = async (tx: Database): Promise<string> => {
  const suffix = randomUUID();
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `ops_code_${suffix}@example.test`,
      username: `ops_code_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No operator row");
  return row.id;
};

const signsIn = async (tx: Database, password: string): Promise<boolean> => {
  const outcome = await authenticateWithEmailPassword(ADDRESS, password, tx);
  return outcome.status === "authenticated";
};

const expectUnverifiedAndUnchanged = async (
  tx: Database,
  userId: string,
  passwordHashBefore: string,
) => {
  const user = await userOf(tx);
  expect(user.emailVerified).toBeNull();
  expect(await storedPasswordHashOf(tx, userId)).toBe(passwordHashBefore);
  const codeRow = await newestCodeRowOf(tx, userId);
  expect(codeRow.consumedAt).toBeNull();
};

describe.skipIf(skipWithoutDatabase)("verifying an email address by code (real database)", () => {
  it("gives the account to the person who typed the code, not to whoever signed up first", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      const invitationId = await seedPendingInvitation(tx);

      await resendRegistrationVerification({ email: ADDRESS }, tx);
      await verify(tx, latestCode(), OWNER_PASSWORD);

      expect(await signsIn(tx, STRANGER_PASSWORD)).toBe(false);
      expect(await signsIn(tx, OWNER_PASSWORD)).toBe(true);

      const user = await userOf(tx);
      expect(user.emailVerified).toBeInstanceOf(Date);
      expect(user.sessionsInvalidBefore).toBeInstanceOf(Date);

      const invitation = await invitationOf(tx, invitationId);
      expect(invitation.targetUserId).toBe(user.id);
      expect(invitation.status).toBe("pending");
    });
  });

  it("verifies a fresh sign-up with the password it chose", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);

      await verify(tx, latestCode(), PASSWORD);

      expect(await signsIn(tx, PASSWORD)).toBe(true);
      const user = await userOf(tx);
      expect(user.emailVerified).toBeInstanceOf(Date);
    });
  });

  it("changes nothing for a wrong code", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const invitationId = await seedPendingInvitation(tx);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);

      await expect(verify(tx, wrongCodeFor(latestCode()), OWNER_PASSWORD)).rejects.toMatchObject({
        code: "verification_code_invalid",
      });

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
      const invitation = await invitationOf(tx, invitationId);
      expect(invitation.status).toBe("pending_claim");
      expect(invitation.targetUserId).toBeNull();
    });
  });

  it("kills a code after 3 wrong tries", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      const code = latestCode();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(verify(tx, wrongCodeFor(code), PASSWORD)).rejects.toMatchObject({
          code: "verification_code_invalid",
        });
      }
      await expect(verify(tx, code, PASSWORD)).rejects.toMatchObject({
        code: "verification_code_attempts_exceeded",
      });
      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);

      await resendRegistrationVerification({ email: ADDRESS }, tx);
      await verify(tx, latestCode(), PASSWORD);

      expect(await signsIn(tx, PASSWORD)).toBe(true);
    });
  });

  it("allows at most 10 wrong tries per account in a day", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);

      const wrongTriesPerCode = [3, 3, 3, 1];
      for (const [index, wrongTries] of wrongTriesPerCode.entries()) {
        if (index > 0) {
          await resendRegistrationVerification({ email: ADDRESS }, tx);
        }
        const code = latestCode();
        for (let attempt = 0; attempt < wrongTries; attempt += 1) {
          await expect(verify(tx, wrongCodeFor(code), PASSWORD)).rejects.toMatchObject({
            code: "verification_code_invalid",
          });
        }
      }

      await expect(verify(tx, latestCode(), PASSWORD)).rejects.toMatchObject({
        code: "verification_code_daily_limit",
      });
      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
    });
  });

  it("refuses a second sign-up for an address that already has an account, writing nothing", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      const roleColumnsBefore = await roleColumnsOf(tx, userId);
      const codeRowBefore = await newestCodeRowOf(tx, userId);
      const codesSentBefore = mocks.sentCodes.length;

      await expect(signUp(tx, OWNER_PASSWORD)).rejects.toMatchObject({
        code: "email_not_verified",
        status: 409,
      });

      expect(await storedPasswordHashOf(tx, userId)).toBe(passwordHashBefore);
      expect(await roleColumnsOf(tx, userId)).toEqual(roleColumnsBefore);
      expect((await newestCodeRowOf(tx, userId)).id).toBe(codeRowBefore.id);
      expect(mocks.sentCodes.length).toBe(codesSentBefore);
    });
  });

  it("refuses a second sign-up for a verified address", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      await verify(tx, latestCode(), PASSWORD);

      await expect(signUp(tx, OWNER_PASSWORD)).rejects.toMatchObject({
        code: "email_exists",
      });

      expect(await signsIn(tx, PASSWORD)).toBe(true);
    });
  });

  it("refuses when only the per-code limit cannot count", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      mocks.unavailableKeyPrefix.current = "rl:register-code:";

      await expect(verify(tx, latestCode(), PASSWORD)).rejects.toMatchObject({
        code: "verification_unavailable",
      });

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
    });
  });

  it("refuses when only the daily limit cannot count", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      mocks.unavailableKeyPrefix.current = "rl:register-code-day:";

      await expect(verify(tx, latestCode(), PASSWORD)).rejects.toMatchObject({
        code: "verification_unavailable",
      });

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
    });
  });

  it("refuses when the guessing limit cannot count", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      mocks.limiterMode.current = "unavailable";

      await expect(verify(tx, latestCode(), OWNER_PASSWORD)).rejects.toMatchObject({
        code: "verification_unavailable",
      });

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
    });
  });

  it("refuses an expired code", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);
      await tx
        .update(schema.userEmailVerificationTokens)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.userEmailVerificationTokens.userId, userId));

      await expect(verify(tx, latestCode(), OWNER_PASSWORD)).rejects.toMatchObject({
        code: "verification_code_invalid",
      });

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);
    });
  });

  it("refuses a code used twice", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const code = latestCode();
      await verify(tx, code, PASSWORD);

      await expect(verify(tx, code, OWNER_PASSWORD)).rejects.toMatchObject({
        code: "email_exists",
      });

      expect(await signsIn(tx, PASSWORD)).toBe(true);
    });
  });

  it("never changes a verified account's password", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      await verify(tx, latestCode(), OWNER_PASSWORD);

      await expect(verify(tx, "000000", PASSWORD)).rejects.toMatchObject({
        code: "email_exists",
      });

      expect(await signsIn(tx, OWNER_PASSWORD)).toBe(true);
    });
  });

  it("stores the code so a database reader cannot recover it", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const code = latestCode();
      const { id: userId } = await userOf(tx);
      const [row] = await tx
        .select({ tokenHash: schema.userEmailVerificationTokens.tokenHash })
        .from(schema.userEmailVerificationTokens)
        .where(eq(schema.userEmailVerificationTokens.userId, userId));
      if (!row) throw new Error("No code row");

      const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
      expect(row.tokenHash).not.toBe(code);
      expect(row.tokenHash).not.toBe(sha256Hex(code));
      expect(row.tokenHash).not.toBe(sha256Hex(`${userId}:${code}`));
    });
  });

  it("replaces a stranger's host sign-up with the details sent with the code", async () => {
    await inRollback(async (tx) => {
      await signUpAsHost(tx, STRANGER_PASSWORD);
      const { id: userId } = await userOf(tx);
      const usernameAfterSignUp = (await accountOf(tx, userId)).username;

      await resendRegistrationVerification({ email: ADDRESS }, tx);
      await verify(tx, latestCode(), OWNER_PASSWORD);

      const account = await accountOf(tx, userId);
      expect(account.name).toBe("Rina Pratama");
      expect(account.username).not.toBe(usernameAfterSignUp);
      const roleColumns = await roleColumnsOf(tx, userId);
      expect(roleColumns.role).toBe("candidate");
      expect(roleColumns.candidateVerifiedAt).toBeInstanceOf(Date);
      expect(roleColumns.recruiterVerifiedAt).toBeNull();
      expect(roleColumns.recruiterVerificationTier).toBe("minimal");
      expect(await displayNameOf(tx, userId)).toBe("Rina Pratama");
      expect(await candidateProfileOf(tx, userId)).toEqual({
        fullName: "Rina Pratama",
        phoneNumber: "0812345678",
        occupation: "college_student",
        dateOfBirth: "2000-01-15",
      });
      expect(await hostRequestsOf(tx, userId)).toHaveLength(0);
    });
  });

  it("replaces a stranger's candidate sign-up with a host sign-up sent with the code", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      const { id: userId } = await userOf(tx);

      await resendRegistrationVerification({ email: ADDRESS }, tx);
      await verify(tx, latestCode(), OWNER_PASSWORD, {
        name: "Rina Pratama",
        signupRole: "recruiter",
        fullName: "Rina Pratama",
        mobileNumber: "081211112222",
        corporateEmail: null,
      });

      const roleColumns = await roleColumnsOf(tx, userId);
      expect(roleColumns.role).toBe("recruiter");
      expect(roleColumns.recruiterVerifiedAt).toBeInstanceOf(Date);
      expect(roleColumns.candidateVerifiedAt).toBeNull();
      expect(roleColumns.recruiterVerificationTier).toBe("minimal");
      expect(await candidateProfileOf(tx, userId)).toBeNull();
      const hostRequests = await hostRequestsOf(tx, userId);
      expect(hostRequests).toHaveLength(1);
      expect(hostRequests[0]).toMatchObject({
        status: "pending_review",
        mobileNumber: "081211112222",
      });
    });
  });

  it("keeps the username of a person who verifies their own sign-up", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, PASSWORD);
      const { id: userId } = await userOf(tx);
      const usernameBefore = (await accountOf(tx, userId)).username;
      const candidateProfileBefore = await candidateProfileOf(tx, userId);

      await verify(tx, latestCode(), PASSWORD);

      expect((await accountOf(tx, userId)).username).toBe(usernameBefore);
      expect(await candidateProfileOf(tx, userId)).toEqual(candidateProfileBefore);
    });
  });

  it("writes no details for a wrong code", async () => {
    await inRollback(async (tx) => {
      await signUpAsHost(tx, STRANGER_PASSWORD);
      const { id: userId } = await userOf(tx);
      const accountBefore = await accountOf(tx, userId);
      const roleBefore = (await roleColumnsOf(tx, userId)).role;
      const hostRequestsBefore = await hostRequestsOf(tx, userId);

      await expect(verify(tx, wrongCodeFor(latestCode()), OWNER_PASSWORD)).rejects.toMatchObject({
        code: "verification_code_invalid",
      });

      expect((await accountOf(tx, userId)).name).toBe(accountBefore.name);
      expect((await roleColumnsOf(tx, userId)).role).toBe(roleBefore);
      expect(await hostRequestsOf(tx, userId)).toEqual(hostRequestsBefore);
      expect(await candidateProfileOf(tx, userId)).toBeNull();
    });
  });

  it("refuses details that sign-up would refuse, before counting a try", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      const detailsWithoutDateOfBirth: Record<string, unknown> = { ...CANDIDATE_DETAILS };
      delete detailsWithoutDateOfBirth.dateOfBirth;

      await expect(
        verify(tx, latestCode(), OWNER_PASSWORD, detailsWithoutDateOfBirth),
      ).rejects.toMatchObject({ status: 400 });

      const countedKeys = limiterKeysCounted().filter(
        (key) => key.startsWith("rl:register-code-day:") || key.startsWith("rl:register-code:"),
      );
      expect(countedKeys).toEqual([]);
      expect((await userOf(tx)).emailVerified).toBeNull();
    });
  });

  it("hides a stranger's host request from platform ops until the owner's verification replaces it", async () => {
    await inRollback(async (tx) => {
      await signUpAsHost(tx, STRANGER_PASSWORD);
      const { id: accountId } = await userOf(tx);
      const [strangerRequest] = await hostRequestsOf(tx, accountId);
      if (!strangerRequest) throw new Error("No recruiter request after the host sign-up");
      const operatorId = await seedOperator(tx);
      const queueEntriesOfAccount = async () =>
        (await listRecruiterVerificationQueue(tx)).filter(
          (entry) => entry.submission.userId === accountId,
        );

      expect(await queueEntriesOfAccount()).toHaveLength(0);
      await expect(
        reviewRecruiterVerification(operatorId, strangerRequest.id, "approve", null, { db: tx }),
      ).rejects.toMatchObject({ code: "recruiter_verification_not_found" });
      await expect(elevateRecruiterTier(operatorId, accountId, tx)).rejects.toMatchObject({
        code: "tier_target_email_not_verified",
      });
      expect((await roleColumnsOf(tx, accountId)).recruiterVerificationTier).toBe("minimal");
      expect((await hostRequestsOf(tx, accountId))[0]?.status).toBe("pending_review");

      await resendRegistrationVerification({ email: ADDRESS }, tx);
      await verify(tx, latestCode(), OWNER_PASSWORD, {
        name: "Rina Pratama",
        signupRole: "recruiter",
        fullName: "Rina Pratama",
        mobileNumber: "081211112222",
        corporateEmail: null,
      });

      const ownerRequests = await hostRequestsOf(tx, accountId);
      expect(ownerRequests).toHaveLength(1);
      const [ownerRequest] = ownerRequests;
      if (!ownerRequest) throw new Error("No recruiter request after the verification");
      expect(ownerRequest.id).not.toBe(strangerRequest.id);
      expect(ownerRequest.mobileNumber).toBe("081211112222");
      expect(ownerRequest.fullName).toBe("Rina Pratama");
      const queueEntries = await queueEntriesOfAccount();
      expect(queueEntries).toHaveLength(1);
      expect(queueEntries[0]?.submission.id).toBe(ownerRequest.id);
    });
  });

  it("leaves the account unverified and the code unused when the replacement fails", async () => {
    await inRollback(async (tx) => {
      await signUp(tx, STRANGER_PASSWORD);
      const code = latestCode();
      const { id: userId } = await userOf(tx);
      const passwordHashBefore = await storedPasswordHashOf(tx, userId);

      const verification = verify(tx, code, OWNER_PASSWORD, {
        ...CANDIDATE_DETAILS,
        dateOfBirth: "2000-02-30",
      });
      const refusal = await verification.then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).not.toBeNull();
      expect(refusal).not.toBeInstanceOf(CredentialsAuthError);

      await expectUnverifiedAndUnchanged(tx, userId, passwordHashBefore);

      await verify(tx, code, OWNER_PASSWORD);
      expect(await signsIn(tx, OWNER_PASSWORD)).toBe(true);
    });
  });
});
