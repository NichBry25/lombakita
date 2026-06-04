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

describe("registerUserWithCredentials — M1 account-takeover guard", () => {
  it("refuses registration over a verified password-less (Google-only) account, writing nothing", async () => {
    const { db, calls } = buildGoogleOnlyVerifiedDb();
    hashPassword.mockResolvedValue("s1$salt$hash");

    await expect(
      registerUserWithCredentials(
        {
          name: "Attacker",
          email: "victim@gmail.com",
          password: "attacker-password",
          signupRole: "recruiter",
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "email_exists", status: 409 });

    // The guard short-circuits before any mutation: no role-flip UPDATE, no profile/password
    // INSERT. Under the pre-fix code these would be > 0 (the takeover write path).
    expect(calls.updates).toBe(0);
    expect(calls.inserts).toBe(0);
  });
});
