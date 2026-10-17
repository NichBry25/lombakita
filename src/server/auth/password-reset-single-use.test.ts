// @vitest-environment node

// THE SINGLE-USE GUARD INSIDE THE CONFIRM TRANSACTION.
//
// `confirmPasswordReset` reads the token, then consumes it with a conditional UPDATE inside the
// transaction and refuses when that UPDATE touched no row. Every sequential test is turned away by
// the earlier read (`tokenRecord.consumedAt`), so none of them reaches the conditional UPDATE. This
// file builds the one input that does: a read that still shows the token as unconsumed, and an
// UPDATE that finds it already consumed, which is what a concurrent confirm leaves behind.
//
// The database is a stub because the interleaving cannot be produced on one connection. The
// positive control below runs the same stub with an UPDATE that wins, so the refusal case cannot
// pass on a stub that never reaches the transaction.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { userPasswordCredentials, userPasswordResetTokens, users } from "@/server/db/schema";

vi.mock("@/server/redis/rate-limit", () => ({
  checkFailedAttemptLimitFailClosed: vi.fn(),
  recordFailedAttemptFailClosed: vi.fn(),
  clearFailedAttempts: vi.fn(),
}));

import { confirmPasswordReset } from "@/server/auth/password-reset";

const RAW_TOKEN = "a".repeat(64);
const NEW_PASSWORD = "new-password-2";

const unconsumedEligibleToken = {
  id: "token-1",
  userId: "user-1",
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  email: "ada@example.test",
  name: "Ada",
  status: "active",
  suspendedAt: null,
  emailVerified: new Date(),
  passwordUserId: "user-1",
};

type Table = object;

const stubDatabase = (conditionalUpdateRows: Array<{ id: string }>) => {
  const updatedTables: Table[] = [];
  const deletedTables: Table[] = [];

  const writeChain = (table: Table) => ({
    set: () => ({
      where: () =>
        Object.assign(Promise.resolve(undefined), {
          returning: async () => (table === userPasswordResetTokens ? conditionalUpdateRows : []),
        }),
    }),
  });

  const transaction = {
    update: vi.fn((table: Table) => {
      updatedTables.push(table);
      return writeChain(table);
    }),
    delete: vi.fn((table: Table) => {
      deletedTables.push(table);
      return { where: async () => undefined };
    }),
  };

  const readChain = {
    from: () => readChain,
    innerJoin: () => readChain,
    leftJoin: () => readChain,
    where: () => readChain,
    limit: async () => [unconsumedEligibleToken],
  };

  const db = {
    select: vi.fn(() => readChain),
    transaction: async (run: (tx: typeof transaction) => Promise<void>) => run(transaction),
  } as unknown as Database;

  return { db, updatedTables, deletedTables };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("confirmPasswordReset — the conditional consume", () => {
  it("refuses, and writes nothing else, when the token was consumed between the read and the update", async () => {
    const { db, updatedTables, deletedTables } = stubDatabase([]);

    await expect(
      confirmPasswordReset({ token: RAW_TOKEN, password: NEW_PASSWORD }, db),
    ).rejects.toMatchObject({ code: "password_reset_token_invalid", status: 400 });

    expect(updatedTables).toEqual([userPasswordResetTokens]);
    expect(updatedTables).not.toContain(userPasswordCredentials);
    expect(updatedTables).not.toContain(users);
    expect(deletedTables).toEqual([]);
  });

  it("sets the password, stamps the account and deletes the other links when the update wins", async () => {
    const { db, updatedTables, deletedTables } = stubDatabase([{ id: "token-1" }]);

    await expect(
      confirmPasswordReset({ token: RAW_TOKEN, password: NEW_PASSWORD }, db),
    ).resolves.toEqual({ userId: "user-1", email: "ada@example.test", name: "Ada" });

    expect(updatedTables).toEqual([userPasswordResetTokens, userPasswordCredentials, users]);
    expect(deletedTables).toEqual([userPasswordResetTokens]);
  });
});
