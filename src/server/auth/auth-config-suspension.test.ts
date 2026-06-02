// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Step 6.2 — session callback reads live suspended_at on every session resolution. This test
// drives the callback directly with a getDb mock whose SELECT returns a configurable row.

let suspendedAtRow: { suspendedAt: Date | null } | null = { suspendedAt: null };

const getDbMock = vi.fn(() => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(suspendedAtRow ? [suspendedAtRow] : []),
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
  users: { id: "id", suspendedAt: "suspended_at", candidateVerifiedAt: "c", recruiterVerifiedAt: "r" },
  accounts: {},
  sessions: {},
  verificationTokens: {},
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type SessionCb = (args: {
  session: { user?: Record<string, unknown> };
  token: Record<string, unknown>;
}) => Promise<{ user?: Record<string, unknown> }>;

const callSession = async (suspendedAt: Date | null) => {
  suspendedAtRow = { suspendedAt };
  const { authOptions } = await import("@/server/auth/auth.config");
  const cb = authOptions.callbacks?.session as unknown as SessionCb;
  return cb({
    session: { user: { email: "a@b.com" } },
    token: { sub: "user_123", role: "candidate", verifiedRoles: ["candidate"] },
  });
};

beforeEach(() => {
  suspendedAtRow = { suspendedAt: null };
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
