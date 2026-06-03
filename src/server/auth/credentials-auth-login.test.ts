// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

// Step 6.5c — login-time suspension block at the credentials-validation layer. These tests drive
// `authenticateWithEmailPassword` directly with a mock db and a mocked password verifier, asserting
// the suspension gate, the check-ordering (account-enumeration safety), and reinstatement. No
// browser-driver involved — the guarantee lives in this service path.

const verifyPasswordMock = vi.fn<(password: string, hash: string) => Promise<boolean>>();

vi.mock("@/server/auth/password", () => ({
  // credentials-auth imports these four from the password module; only verifyPassword is exercised
  // by authenticateWithEmailPassword, but all are stubbed so the module import resolves.
  hashPassword: vi.fn(),
  verifyPassword: (password: string, hash: string) => verifyPasswordMock(password, hash),
  hashVerificationToken: vi.fn(),
  issueVerificationToken: vi.fn(),
}));

import { authenticateWithEmailPassword } from "@/server/auth/credentials-auth";
import type { Database } from "@/server/db/client";

type Row = {
  id: string;
  email: string;
  role: string;
  emailVerified: Date | null;
  suspendedAt: Date | null;
  passwordHash: string | null;
};

// Minimal chainable stub matching db.select({...}).from().leftJoin().where().limit() → Promise<Row[]>
const dbReturning = (rows: Row[]): Database => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Database;
};

const baseRow: Row = {
  id: "user_1",
  email: "user@example.com",
  role: "candidate",
  emailVerified: new Date("2026-01-01T00:00:00.000Z"),
  suspendedAt: null,
  passwordHash: "s1$deadbeef$cafef00d",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("authenticateWithEmailPassword — suspension block (Step 6.5c)", () => {
  it("returns account_suspended for a suspended account with the correct password", async () => {
    verifyPasswordMock.mockResolvedValue(true);
    const db = dbReturning([{ ...baseRow, suspendedAt: new Date("2026-06-01T00:00:00.000Z") }]);

    const result = await authenticateWithEmailPassword("user@example.com", "correct-password", db);

    expect(result.status).toBe("account_suspended");
    // No user object is surfaced, so authorize never returns one → no JWT/session is issued.
    expect(result).not.toHaveProperty("user");
  });

  it("returns the generic invalid_credentials for a suspended account with a WRONG password (no enumeration)", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const db = dbReturning([{ ...baseRow, suspendedAt: new Date("2026-06-01T00:00:00.000Z") }]);

    const result = await authenticateWithEmailPassword("user@example.com", "wrong-password", db);

    // Must be indistinguishable from any other failed login — the suspended signal is never
    // observable to someone who did not supply the correct password.
    expect(result.status).toBe("invalid_credentials");
  });

  it("authenticates a non-suspended, verified account normally", async () => {
    verifyPasswordMock.mockResolvedValue(true);
    const db = dbReturning([{ ...baseRow, suspendedAt: null }]);

    const result = await authenticateWithEmailPassword("user@example.com", "correct-password", db);

    expect(result.status).toBe("authenticated");
    if (result.status === "authenticated") {
      expect(result.user).toEqual({
        id: "user_1",
        email: "user@example.com",
        role: "candidate",
      });
    }
  });

  it("authenticates a reinstated account (suspended_at cleared) normally", async () => {
    verifyPasswordMock.mockResolvedValue(true);
    // Reinstatement nulls suspended_at; login must succeed with no suspended routing.
    const db = dbReturning([{ ...baseRow, suspendedAt: null }]);

    const result = await authenticateWithEmailPassword("user@example.com", "correct-password", db);

    expect(result.status).toBe("authenticated");
  });

  it("does not read suspension before the password is verified (wrong password short-circuits)", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const db = dbReturning([{ ...baseRow, suspendedAt: new Date("2026-06-01T00:00:00.000Z") }]);

    const result = await authenticateWithEmailPassword("user@example.com", "wrong-password", db);

    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("invalid_credentials");
  });
});
