// @vitest-environment node

// The password-recovery services, driven against real rows in a rolled-back transaction, so the
// population rule, the token lifecycle and the revocation stamp are measured on what Postgres
// stores rather than on a mocked query chain. `hashPassword` and `verifyPassword` are wrapped in
// spies (the real implementation still runs) so the ORDER of work can be asserted: a guessed token
// and a limited account must do no scrypt work.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  checkFailedAttemptLimitFailClosed: vi.fn(),
  recordFailedAttemptFailClosed: vi.fn(),
  clearFailedAttempts: vi.fn(),
}));

vi.mock("@/server/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/password")>();
  mocks.hashPassword.mockImplementation(actual.hashPassword);
  mocks.verifyPassword.mockImplementation(actual.verifyPassword);

  return { ...actual, hashPassword: mocks.hashPassword, verifyPassword: mocks.verifyPassword };
});
vi.mock("@/server/redis/rate-limit", () => ({
  checkFailedAttemptLimitFailClosed: mocks.checkFailedAttemptLimitFailClosed,
  recordFailedAttemptFailClosed: mocks.recordFailedAttemptFailClosed,
  clearFailedAttempts: mocks.clearFailedAttempts,
}));

import { hashPassword, hashVerificationToken, verifyPassword } from "@/server/auth/password";
import {
  changePassword,
  confirmPasswordReset,
  requestPasswordReset,
} from "@/server/auth/password-reset";

const realHashPassword = mocks.hashPassword.getMockImplementation()!;
const realVerifyPassword = mocks.verifyPassword.getMockImplementation()!;

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

const OLD_PASSWORD = "old-password-1";
const NEW_PASSWORD = "new-password-2";

type AccountOverrides = {
  emailVerified?: Date | null;
  suspendedAt?: Date | null;
  status?: "active" | "suspended" | "deactivated";
  withPassword?: boolean;
  name?: string | null;
};

const createAccount = async (tx: Database, overrides: AccountOverrides = {}) => {
  const suffix = crypto.randomUUID();
  const [account] = await tx
    .insert(schema.users)
    .values({
      email: `${suffix}@example.test`,
      username: `pw-${suffix}`,
      name: overrides.name === undefined ? "Siti Aminah" : overrides.name,
      role: "candidate",
      candidateVerifiedAt: new Date(),
      emailVerified: overrides.emailVerified === undefined ? new Date() : overrides.emailVerified,
      suspendedAt: overrides.suspendedAt ?? null,
      status: overrides.status ?? "active",
    })
    .returning({ id: schema.users.id, email: schema.users.email });
  if (!account) throw new Error("Account fixture was not inserted");

  if (overrides.withPassword !== false) {
    await tx.insert(schema.userPasswordCredentials).values({
      userId: account.id,
      passwordHash: await realHashPassword(OLD_PASSWORD),
    });
  }

  return account as { id: string; email: string };
};

// A read that still shows the token as unconsumed while the row is already consumed: what a
// concurrent confirm leaves a second request holding. Everything else is the real transaction.
const withStaleTokenRead = (tx: Database, staleReads: { count: number }): Database => {
  const staleChain = <Builder extends object>(builder: Builder): Builder =>
    new Proxy(builder, {
      get(target, property) {
        const member = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        if (property === "limit") {
          return async (count: number) => {
            const rows = (await member.call(target, count)) as Array<Record<string, unknown>>;
            staleReads.count += 1;
            return rows.map((row) => ({ ...row, consumedAt: null }));
          };
        }
        return (...args: unknown[]) => staleChain(member.apply(target, args));
      },
    });

  return {
    select: (fields: never) => staleChain(tx.select(fields)),
    transaction: (run: Parameters<Database["transaction"]>[0]) => tx.transaction(run),
  } as unknown as Database;
};

const tokensOf = (tx: Database, userId: string) =>
  tx
    .select()
    .from(schema.userPasswordResetTokens)
    .where(eq(schema.userPasswordResetTokens.userId, userId));

const stampOf = async (tx: Database, userId: string): Promise<Date | null> => {
  const [row] = await tx
    .select({ stamp: schema.users.sessionsInvalidBefore })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.stamp ?? null;
};

const storedHashOf = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ hash: schema.userPasswordCredentials.passwordHash })
    .from(schema.userPasswordCredentials)
    .where(eq(schema.userPasswordCredentials.userId, userId));
  if (!row) throw new Error("No credential row");
  return row.hash;
};

const issueTokenFor = async (tx: Database, email: string): Promise<string> => {
  const outcome = await requestPasswordReset(email, tx);
  if (outcome.action !== "send_reset")
    throw new Error(`expected send_reset, got ${outcome.action}`);
  return outcome.rawToken;
};

beforeEach(() => {
  mocks.hashPassword.mockImplementation(realHashPassword);
  mocks.verifyPassword.mockImplementation(realVerifyPassword);
  mocks.checkFailedAttemptLimitFailClosed.mockResolvedValue({
    limited: false,
    retryAfterSeconds: 0,
  });
  mocks.recordFailedAttemptFailClosed.mockResolvedValue(undefined);
  mocks.clearFailedAttempts.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(skipWithoutDatabase)("requestPasswordReset — the population rule", () => {
  it("does nothing for an unknown address", async () => {
    await inRollback(async (tx) => {
      await expect(requestPasswordReset("nobody@example.test", tx)).resolves.toEqual({
        action: "none",
      });
    });
  });

  it.each([
    ["a suspended account", { suspendedAt: new Date() }],
    ["a deactivated account", { status: "deactivated" as const }],
    ["an unverified address", { emailVerified: null }],
  ])("does nothing for %s, and issues no token", async (_label, overrides) => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, overrides);

      await expect(requestPasswordReset(account.email, tx)).resolves.toEqual({ action: "none" });
      expect(await tokensOf(tx, account.id)).toEqual([]);
    });
  });

  it("sends the Google notice, and issues no token, for an account with no password row", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, { withPassword: false });

      const outcome = await requestPasswordReset(account.email, tx);

      expect(outcome).toEqual({
        action: "send_google_notice",
        userId: account.id,
        email: account.email,
        name: "Siti Aminah",
      });
      expect(await tokensOf(tx, account.id)).toEqual([]);
    });
  });

  it("issues a 30-minute token for a normal account and stores only its hash", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const before = Date.now();

      const outcome = await requestPasswordReset(account.email, tx);

      if (outcome.action !== "send_reset") throw new Error("expected send_reset");
      expect(outcome.rawToken).toMatch(/^[a-f0-9]{64}$/);
      const [stored] = await tokensOf(tx, account.id);
      expect(stored!.tokenHash).toBe(hashVerificationToken(outcome.rawToken));
      expect(stored!.tokenHash).not.toBe(outcome.rawToken);
      expect(stored!.consumedAt).toBeNull();
      // Literal 30 minutes, not the exported constant: a lifetime edited in step with its own test
      // would otherwise move both.
      const lifetime = stored!.expiresAt.getTime() - before;
      expect(lifetime).toBeGreaterThan(1_800_000 - 5000);
      expect(lifetime).toBeLessThanOrEqual(1_800_000 + 5000);
    });
  });

  it("falls back to the default display name when the account has none", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, { name: null });

      const outcome = await requestPasswordReset(account.email, tx);

      expect(outcome).toMatchObject({ name: "Pengguna Lombakita" });
    });
  });

  it("leaves only the newest link working", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const first = await issueTokenFor(tx, account.email);
      const second = await issueTokenFor(tx, account.email);

      expect(await tokensOf(tx, account.id)).toHaveLength(1);
      await expect(
        confirmPasswordReset({ token: first, password: NEW_PASSWORD }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid", status: 400 });
      await expect(
        confirmPasswordReset({ token: second, password: NEW_PASSWORD }, tx),
      ).resolves.toMatchObject({ email: account.email });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("confirmPasswordReset", () => {
  it("sets the new password, consumes the token, stamps the account and voids the other links", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);
      // A second, unconsumed link inserted directly: requestPasswordReset would delete the first.
      await tx.insert(schema.userPasswordResetTokens).values({
        userId: account.id,
        tokenHash: hashVerificationToken("b".repeat(64)),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const before = Date.now();

      const result = await confirmPasswordReset({ token, password: NEW_PASSWORD }, tx);

      expect(result).toEqual({ userId: account.id, email: account.email, name: "Siti Aminah" });
      const hash = await storedHashOf(tx, account.id);
      expect(await realVerifyPassword(NEW_PASSWORD, hash)).toBe(true);
      expect(await realVerifyPassword(OLD_PASSWORD, hash)).toBe(false);
      const remaining = await tokensOf(tx, account.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.tokenHash).toBe(hashVerificationToken(token));
      expect(remaining[0]!.consumedAt).not.toBeNull();
      const stamp = await stampOf(tx, account.id);
      expect(stamp).not.toBeNull();
      expect(stamp!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stamp!.getTime()).toBe(remaining[0]!.consumedAt!.getTime());
    });
  });

  it("does no hashing work for a token that does not exist", async () => {
    await inRollback(async (tx) => {
      await expect(
        confirmPasswordReset({ token: "a".repeat(64), password: NEW_PASSWORD }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid", status: 400 });

      expect(mocks.hashPassword).not.toHaveBeenCalled();
    });
  });

  it("does no hashing work for a malformed token", async () => {
    await inRollback(async (tx) => {
      await expect(
        confirmPasswordReset({ token: "not-hex", password: NEW_PASSWORD }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid" });

      expect(mocks.hashPassword).not.toHaveBeenCalled();
    });
  });

  it("rejects a consumed token as invalid, without hashing", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);
      await confirmPasswordReset({ token, password: NEW_PASSWORD }, tx);
      mocks.hashPassword.mockClear();

      await expect(
        confirmPasswordReset({ token, password: "third-password-3" }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid", status: 400 });

      expect(mocks.hashPassword).not.toHaveBeenCalled();
    });
  });

  it("refuses, and changes nothing, when the token was consumed between the read and the update", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);
      await confirmPasswordReset({ token, password: NEW_PASSWORD }, tx);
      const hashAfterFirstUse = await storedHashOf(tx, account.id);
      const stampAfterFirstUse = await stampOf(tx, account.id);
      const staleReads = { count: 0 };

      await expect(
        confirmPasswordReset(
          { token, password: "third-password-3" },
          withStaleTokenRead(tx, staleReads),
        ),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid", status: 400 });

      expect(staleReads.count).toBe(1);
      expect(await storedHashOf(tx, account.id)).toBe(hashAfterFirstUse);
      expect(await realVerifyPassword("third-password-3", hashAfterFirstUse)).toBe(false);
      expect(await stampOf(tx, account.id)).toEqual(stampAfterFirstUse);
    });
  });

  it("rejects an expired token as expired, without hashing", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);
      await tx
        .update(schema.userPasswordResetTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.userPasswordResetTokens.userId, account.id));

      await expect(
        confirmPasswordReset({ token, password: NEW_PASSWORD }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_expired", status: 400 });

      expect(mocks.hashPassword).not.toHaveBeenCalled();
    });
  });

  it("rejects a token whose account was suspended after the link was issued", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);
      await tx
        .update(schema.users)
        .set({ suspendedAt: new Date() })
        .where(eq(schema.users.id, account.id));

      await expect(
        confirmPasswordReset({ token, password: NEW_PASSWORD }, tx),
      ).rejects.toMatchObject({ code: "password_reset_token_invalid" });

      expect(mocks.hashPassword).not.toHaveBeenCalled();
      expect(await stampOf(tx, account.id)).toBeNull();
    });
  });

  it("refuses a password outside 8 to 72 characters and leaves the link usable", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      const token = await issueTokenFor(tx, account.email);

      await expect(confirmPasswordReset({ token, password: "short" }, tx)).rejects.toMatchObject({
        code: "invalid_password",
        status: 400,
      });

      const [stored] = await tokensOf(tx, account.id);
      expect(stored!.consumedAt).toBeNull();
      expect(await stampOf(tx, account.id)).toBeNull();
    });
  });
});

describe.skipIf(skipWithoutDatabase)("changePassword", () => {
  it("checks the limiter before it verifies the current password", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      mocks.checkFailedAttemptLimitFailClosed.mockResolvedValue({
        limited: true,
        retryAfterSeconds: 321,
      });

      const result = await changePassword(
        { userId: account.id, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
        tx,
      );

      expect(result).toEqual({ outcome: "rate_limited", retryAfterSeconds: 321 });
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
      expect(mocks.hashPassword).not.toHaveBeenCalled();
      expect(await stampOf(tx, account.id)).toBeNull();
    });
  });

  it("refuses, verifying nothing, when the limiter cannot confirm the count", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      mocks.checkFailedAttemptLimitFailClosed.mockRejectedValue(new Error("redis down"));

      const result = await changePassword(
        { userId: account.id, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
        tx,
      );

      expect(result).toEqual({ outcome: "limiter_unavailable" });
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
    });
  });

  it("records a wrong guess and refuses it", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);

      await expect(
        changePassword(
          { userId: account.id, currentPassword: "wrong-password", newPassword: NEW_PASSWORD },
          tx,
        ),
      ).rejects.toMatchObject({ code: "invalid_current_password", status: 400 });

      expect(mocks.recordFailedAttemptFailClosed).toHaveBeenCalledOnce();
      expect(await stampOf(tx, account.id)).toBeNull();
    });
  });

  it("verifies the trimmed current password, because the stored hash is of the trimmed password", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);

      const result = await changePassword(
        { userId: account.id, currentPassword: `  ${OLD_PASSWORD}  `, newPassword: NEW_PASSWORD },
        tx,
      );

      expect(result).toMatchObject({ outcome: "changed" });
      expect(mocks.verifyPassword).toHaveBeenCalledWith(OLD_PASSWORD, expect.any(String));
    });
  });

  // Sign-in refuses a wrong-length password in parsePassword, before any lookup or scrypt work, and
  // its authorize wrapper records no failed attempt for it. Literal lengths, not the shared limits,
  // so a limit edited in step with its own test would not move both.
  describe("a current password of the wrong length, as sign-in treats it", () => {
    const refuseWithoutWork = async (currentPassword: string) => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx);

        await expect(
          changePassword({ userId: account.id, currentPassword, newPassword: NEW_PASSWORD }, tx),
        ).rejects.toMatchObject({
          code: "invalid_current_password",
          status: 400,
          message: "Password saat ini salah.",
        });

        expect(mocks.verifyPassword).not.toHaveBeenCalled();
        expect(mocks.recordFailedAttemptFailClosed).not.toHaveBeenCalled();
        expect(await stampOf(tx, account.id)).toBeNull();
      });
    };

    it("refuses 73 characters without verifying and without recording a failed attempt", async () => {
      await refuseWithoutWork("a".repeat(73));
    });

    it("refuses 7 characters without verifying and without recording a failed attempt", async () => {
      await refuseWithoutWork("a".repeat(7));
    });

    it("judges the length on the trimmed value, so 72 characters padded with spaces reach verifyPassword", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx);

        await expect(
          changePassword(
            {
              userId: account.id,
              currentPassword: `  ${"a".repeat(72)}  `,
              newPassword: NEW_PASSWORD,
            },
            tx,
          ),
        ).rejects.toMatchObject({ code: "invalid_current_password" });

        expect(mocks.verifyPassword).toHaveBeenCalledOnce();
        expect(mocks.verifyPassword).toHaveBeenCalledWith("a".repeat(72), expect.any(String));
        expect(mocks.recordFailedAttemptFailClosed).toHaveBeenCalledOnce();
      });
    });

    it("lets exactly 72 characters reach verifyPassword, where a wrong one is counted", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx);

        await expect(
          changePassword(
            { userId: account.id, currentPassword: "a".repeat(72), newPassword: NEW_PASSWORD },
            tx,
          ),
        ).rejects.toMatchObject({ code: "invalid_current_password" });

        expect(mocks.verifyPassword).toHaveBeenCalledOnce();
        expect(mocks.recordFailedAttemptFailClosed).toHaveBeenCalledOnce();
      });
    });

    it("still answers 409 password_not_set for a Google-only account, whatever the length", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx, { withPassword: false });

        await expect(
          changePassword(
            { userId: account.id, currentPassword: "a".repeat(73), newPassword: NEW_PASSWORD },
            tx,
          ),
        ).rejects.toMatchObject({ code: "password_not_set", status: 409 });

        expect(mocks.verifyPassword).not.toHaveBeenCalled();
      });
    });

    it("checks the limiter before the length", async () => {
      await inRollback(async (tx) => {
        const account = await createAccount(tx);
        mocks.checkFailedAttemptLimitFailClosed.mockResolvedValue({
          limited: true,
          retryAfterSeconds: 60,
        });

        const result = await changePassword(
          { userId: account.id, currentPassword: "a".repeat(73), newPassword: NEW_PASSWORD },
          tx,
        );

        expect(result).toEqual({ outcome: "rate_limited", retryAfterSeconds: 60 });
      });
    });
  });

  it("limits wrong guesses per account, 5 in 15 minutes, on the literal key", async () => {
    // Literals, not the exported constant: a limit or key edited in step with its own test would
    // otherwise move both.
    await inRollback(async (tx) => {
      const account = await createAccount(tx);

      await expect(
        changePassword(
          { userId: account.id, currentPassword: "wrong-password", newPassword: NEW_PASSWORD },
          tx,
        ),
      ).rejects.toMatchObject({ code: "invalid_current_password" });

      expect(mocks.checkFailedAttemptLimitFailClosed).toHaveBeenCalledWith({
        key: `rl:password-change-fail:${account.id}`,
        limit: 5,
        windowSeconds: 900,
      });
      expect(mocks.recordFailedAttemptFailClosed).toHaveBeenCalledWith({
        key: `rl:password-change-fail:${account.id}`,
        windowSeconds: 900,
      });
    });
  });

  it("answers 503 territory when a wrong guess cannot be recorded", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      mocks.recordFailedAttemptFailClosed.mockRejectedValue(new Error("redis down"));

      const result = await changePassword(
        { userId: account.id, currentPassword: "wrong-password", newPassword: NEW_PASSWORD },
        tx,
      );

      expect(result).toEqual({ outcome: "limiter_unavailable" });
    });
  });

  it("refuses an account with no password row", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx, { withPassword: false });

      await expect(
        changePassword(
          { userId: account.id, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
          tx,
        ),
      ).rejects.toMatchObject({ code: "password_not_set", status: 409 });
    });
  });

  it("changes the password, stamps the account, voids unconsumed links and clears the counter", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);
      await issueTokenFor(tx, account.email);
      const before = Date.now();

      const result = await changePassword(
        { userId: account.id, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
        tx,
      );

      expect(result).toEqual({ outcome: "changed", email: account.email, name: "Siti Aminah" });
      const hash = await storedHashOf(tx, account.id);
      expect(await realVerifyPassword(NEW_PASSWORD, hash)).toBe(true);
      expect(await realVerifyPassword(OLD_PASSWORD, hash)).toBe(false);
      const stamp = await stampOf(tx, account.id);
      expect(stamp!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await tokensOf(tx, account.id)).toEqual([]);
      expect(mocks.clearFailedAttempts).toHaveBeenCalledOnce();
    });
  });

  it("refuses a new password outside 8 to 72 characters after the current one verifies", async () => {
    await inRollback(async (tx) => {
      const account = await createAccount(tx);

      await expect(
        changePassword(
          { userId: account.id, currentPassword: OLD_PASSWORD, newPassword: "short" },
          tx,
        ),
      ).rejects.toMatchObject({ code: "invalid_password", status: 400 });

      expect(await stampOf(tx, account.id)).toBeNull();
    });
  });
});

describe("password helpers stay the real implementation", () => {
  it("wraps rather than replaces hashPassword and verifyPassword", async () => {
    const hash = await hashPassword("a-valid-password");

    expect(await verifyPassword("a-valid-password", hash)).toBe(true);
  });
});
