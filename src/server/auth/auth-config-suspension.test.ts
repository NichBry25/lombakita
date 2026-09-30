// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

import { AccessError, assertAuthenticatedSession } from "@/server/auth/access-core";

// The session callback reads live suspended_at and status on every session resolution. This test
// drives the callback directly with a getDb mock whose SELECT returns a configurable row.

let accountRow: { role: string | null; status: string; suspendedAt: Date | null } | null = {
  role: "candidate",
  status: "active",
  suspendedAt: null,
};

const getDbMock = vi.fn(() => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(accountRow ? [accountRow] : []),
      }),
    }),
  }),
}));

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({ adapter: "mock" })) }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn((c: unknown) => c) }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "http://localhost:3000" } }));
vi.mock("@/config/env.server", () => ({
  assertRuntimeEnv: vi.fn(),
  serverEnv: {
    resendApiKey: "k",
    authEmailFrom: "noreply@example.com",
    databaseUrl: "postgresql://local",
    authSecret: "secret",
    authUrl: "http://localhost:3000",
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/server/auth/credentials-auth", () => ({ authenticateWithEmailPassword: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: getDbMock }));
vi.mock("@/server/db/schema", () => ({
  users: {
    id: "id",
    role: "role",
    status: "status",
    suspendedAt: "suspended_at",
    candidateVerifiedAt: "c",
    recruiterVerifiedAt: "r",
  },
  accounts: {},
  sessions: {},
  verificationTokens: {},
  // Step 7.1-MFA: see the identical comment in auth-config-authorize.test.ts.
  mfaFactors: { userId: "user_id", verifiedAt: "verified_at" },
  // Reached transitively via oauth-account → candidate-profile-core, which reads .enumValues
  // at module load.
  candidateOccupationEnum: {
    enumValues: ["school_student", "college_student", "new_graduate", "professional", "other"],
  },
  candidateProfiles: {
    userId: "user_id",
    fullName: "full_name",
    phoneNumber: "phone_number",
    occupation: "occupation",
    dateOfBirth: "date_of_birth",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type SessionCb = (args: {
  session: { user?: Record<string, unknown> };
  token: Record<string, unknown>;
}) => Promise<{ user?: Record<string, unknown> }>;

const callSession = async (suspendedAt: Date | null, status = "active") => {
  accountRow = { role: "candidate", status, suspendedAt };
  const { authOptions } = await import("@/server/auth/auth.config");
  const cb = authOptions.callbacks?.session as unknown as SessionCb;
  return cb({
    session: { user: { email: "a@b.com" } },
    token: { sub: "user_123", role: "candidate", verifiedRoles: ["candidate"] },
  });
};

beforeEach(() => {
  accountRow = { role: "candidate", status: "active", suspendedAt: null };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("session callback suspendedAt", () => {
  it("sets session.user.suspendedAt when the DB row has suspended_at", async () => {
    const result = await callSession(new Date("2026-06-02T00:00:00.000Z"));
    expect(result.user?.suspendedAt).toBe("2026-06-02T00:00:00.000Z");
  });

  it("leaves session.user.suspendedAt undefined when suspended_at is null", async () => {
    const result = await callSession(null);
    expect(result.user?.suspendedAt).toBeUndefined();
  });
});

describe("session callback status", () => {
  it("surfaces no role for a de-identified account whose suspended_at is null", async () => {
    // The tombstone row carries suspended_at NULL, so the suspension gate above never fires for it —
    // status is the only thing that ends its sessions.
    const result = await callSession(null, "deactivated");

    expect(result.user?.role).toBeUndefined();

    // Refused through the existing path, unchanged: the callback surfaces no role, and the access
    // layer's first gate turns a roleless session into a 401 on the account's very next request.
    try {
      assertAuthenticatedSession(result as unknown as Session);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AccessError);
      expect((error as AccessError).code).toBe("unauthenticated");
      expect((error as AccessError).status).toBe(401);
    }
  });
});
