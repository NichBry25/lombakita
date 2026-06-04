// @vitest-environment node
//
// Step 6.5d.1 — method-first credentials entry classification. classifyEmailForLogin maps an email
// to none | unverified | verified so the single login page can branch (sign-in / verify-notice /
// signup) without a separate page. Verified is keyed off users.emailVerified (the same column the
// safe-link gate and credentials login use), so a Google-only account (emailVerified set, no
// password) classifies `verified` and the password attempt collapses to invalid-credentials.

import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/username/generate", () => ({
  generateUsername: vi.fn(),
  UsernameGenerationError: class extends Error {},
}));
vi.mock("@/server/auth/password", () => ({
  hashPassword: vi.fn(),
  hashVerificationToken: vi.fn(),
  issueVerificationToken: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock("@/server/auth/email-verification", () => ({ sendRegistrationVerificationEmail: vi.fn() }));

import { classifyEmailForLogin, CredentialsAuthError } from "@/server/auth/credentials-auth";

const makeDb = (rows: unknown[]) => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  }),
});

describe("classifyEmailForLogin", () => {
  it("returns `none` when no account exists for the email", async () => {
    const result = await classifyEmailForLogin("new@example.com", makeDb([]) as never);
    expect(result).toEqual({ state: "none" });
  });

  it("returns `unverified` when an account exists but emailVerified is null", async () => {
    const result = await classifyEmailForLogin(
      "pending@example.com",
      makeDb([{ id: "u1", emailVerified: null }]) as never,
    );
    expect(result).toEqual({ state: "unverified" });
  });

  it("returns `verified` when the account's emailVerified is set", async () => {
    const result = await classifyEmailForLogin(
      "active@example.com",
      makeDb([{ id: "u1", emailVerified: new Date() }]) as never,
    );
    expect(result).toEqual({ state: "verified" });
  });

  it("classifies a Google-only verified account (no password) as `verified`", async () => {
    // A Google-linked account has emailVerified set from the Google flag but no password row; it
    // must classify `verified` so the page attempts sign-in (→ generic invalid-credentials) rather
    // than offering signup (which would 23505 / risk writing a password onto the account).
    const result = await classifyEmailForLogin(
      "google-user@example.com",
      makeDb([{ id: "u1", emailVerified: new Date() }]) as never,
    );
    expect(result).toEqual({ state: "verified" });
  });

  it("rejects an invalid email before touching the database", async () => {
    const db = makeDb([]);
    const selectSpy = vi.spyOn(db, "select");
    await expect(classifyEmailForLogin("not-an-email", db as never)).rejects.toBeInstanceOf(
      CredentialsAuthError,
    );
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
