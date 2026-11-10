// @vitest-environment node
//
// Step 6.5d.1 (M1) — account-takeover regression guard.
//
// 6.5d introduced verified password-less accounts (Google-only: emailVerified set, no
// user_password_credentials row). The PUBLIC POST /api/v1/auth/register duplicate guard previously
// only threw email_exists when a password row existed, so a Google-only account fell through and an
// unauthenticated attacker who knew the email could write an attacker password (and flip the role)
// onto it — silent account takeover. The fix makes the guard fire for ANY verified account.
//
// This test is built to FAIL under the pre-fix code: the first select (existingUser-by-email)
// returns a VERIFIED row and every later select returns [] (no password credential), so the old
// code would fall through the guard and reach the role-flip UPDATE / password INSERT. It asserts
// email_exists AND that zero inserts/updates ran — i.e. the existing row's role and verification
// timestamps are untouched and no password row is written.

import { describe, expect, it, vi } from "vitest";

const { mockGetDb, hashPassword } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/username/generate", () => ({
  generateUsername: vi.fn(),
  UsernameGenerationError: class extends Error {},
}));
vi.mock("@/server/auth/password", () => ({
  hashPassword,
  hashVerificationToken: vi.fn(),
  issueVerificationToken: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock("@/server/auth/email-verification", () => ({ sendRegistrationVerificationEmail: vi.fn() }));

import { registerUserWithCredentials } from "@/server/auth/credentials-auth";
import { users } from "@/server/db/schema";

const buildGoogleOnlyVerifiedDb = () => {
  const calls = { selects: 0, inserts: 0, updates: 0 };

  const tx = {
    select: vi.fn(() => {
      calls.selects += 1;
      // Call 1 = existingUser-by-email → a verified, password-less (Google-only) account.
      // Any later select (the pre-fix existingCredential probe, or username availability) → [].
      const rows =
        calls.selects === 1
          ? [{ id: "victim-id", emailVerified: new Date("2026-01-01T00:00:00.000Z") }]
          : [];
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(rows));
      return chain;
    }),
    insert: vi.fn(() => {
      calls.inserts += 1;
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn(() => chain);
      chain.returning = vi.fn(() => Promise.resolve([{ id: "x" }]));
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
    update: vi.fn(() => {
      calls.updates += 1;
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn(() => chain);
      chain.where = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  return { db, calls };
};

const buildUnverifiedExistingDb = () => {
  const calls = { selects: 0, inserts: 0, updates: 0 };

  const tx = {
    select: vi.fn(() => {
      calls.selects += 1;
      const rows = calls.selects === 1 ? [{ id: "unverified-id", emailVerified: null }] : [];
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(rows));
      return chain;
    }),
    insert: vi.fn(() => {
      calls.inserts += 1;
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn(() => chain);
      chain.returning = vi.fn(() => Promise.resolve([{ id: "x" }]));
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
    update: vi.fn(() => {
      calls.updates += 1;
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn(() => chain);
      chain.where = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  return { db, calls };
};

const buildInsertFailingDb = (constraintName: string) => {
  const driverFailure = Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint_name: constraintName,
    }),
  });

  const tx = {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve([]));
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn(() => chain);
      chain.returning = vi.fn(() =>
        table === users ? Promise.reject(driverFailure) : Promise.resolve([{ id: "x" }]),
      );
      chain.onConflictDoNothing = vi.fn(() => Promise.resolve(undefined));
      chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
      return chain;
    }),
  };

  const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  return { db };
};

describe("registerUserWithCredentials — M1 account-takeover guard", () => {
  it("refuses registration over a verified password-less (Google-only) account, writing nothing", async () => {
    const { db, calls } = buildGoogleOnlyVerifiedDb();
    hashPassword.mockResolvedValue("s1$salt$hash");

    await expect(
      registerUserWithCredentials(
        {
          name: "Attacker",
          email: "victim@seed.lombakita.local",
          password: "attacker-password",
          signupRole: "recruiter",
          fullName: "Rendra Wijaya",
          mobileNumber: "0812345678",
          corporateEmail: "rendra@corp.co.id",
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_exists", status: 409 });

    // The guard short-circuits before any mutation: no role-flip UPDATE, no profile/password
    // INSERT. Under the pre-fix code these would be > 0 (the takeover write path).
    expect(calls.updates).toBe(0);
    expect(calls.inserts).toBe(0);
  });

  it("refuses registration over an unverified account, writing nothing", async () => {
    const { db, calls } = buildUnverifiedExistingDb();
    hashPassword.mockResolvedValue("s1$salt$hash");

    await expect(
      registerUserWithCredentials(
        {
          name: "Attacker",
          email: "unverified@seed.lombakita.local",
          password: "attacker-password",
          signupRole: "recruiter",
          fullName: "Rendra Wijaya",
          mobileNumber: "0812345678",
          corporateEmail: "rendra@corp.co.id",
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_not_verified", status: 409 });

    expect(calls.updates).toBe(0);
    expect(calls.inserts).toBe(0);
  });

  it("reports a username clash found on the error's cause as a retryable failure", async () => {
    const { db } = buildInsertFailingDb("users_username_unique_idx");
    hashPassword.mockResolvedValue("s1$salt$hash");

    await expect(
      registerUserWithCredentials(
        {
          name: "Rendra Wijaya",
          email: "fresh@seed.lombakita.local",
          password: "very-strong-password",
          signupRole: "recruiter",
          fullName: "Rendra Wijaya",
          mobileNumber: "0812345678",
          corporateEmail: "rendra@corp.co.id",
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "username_generation_failed", status: 503 });
  });

  it("reports an email clash found on the error's cause as email_exists", async () => {
    const { db } = buildInsertFailingDb("users_email_unique");
    hashPassword.mockResolvedValue("s1$salt$hash");

    await expect(
      registerUserWithCredentials(
        {
          name: "Rendra Wijaya",
          email: "fresh@seed.lombakita.local",
          password: "very-strong-password",
          signupRole: "recruiter",
          fullName: "Rendra Wijaya",
          mobileNumber: "0812345678",
          corporateEmail: "rendra@corp.co.id",
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_exists", status: 409 });
  });
});
