// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

// Step 6.5c — the credentials authorize() maps the service's account_suspended status to a thrown
// ACCOUNT_SUSPENDED signal. next-auth v4 (core/routes/callback.js) redirects credentials authorize
// throws to `?error=<message>`, which the react signIn client reads back as result.error; the
// sign-in form routes ACCOUNT_SUSPENDED to /suspended. The invariant verified here: a suspended
// login throws (so authorize returns no user → no JWT/session) and the signal is distinct.

const authenticateMock =
  vi.fn<
    () => Promise<
      | { status: "authenticated"; user: { id: string; email: string; role: string } }
      | { status: "email_not_verified" }
      | { status: "account_suspended" }
      | { status: "invalid_credentials" }
    >
  >();

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({ adapter: "mock" })) }));
// The credentials provider mock returns the config verbatim so we can reach authorize().
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn((config: unknown) => config) }));
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
vi.mock("@/server/auth/credentials-auth", () => ({
  authenticateWithEmailPassword: () => authenticateMock(),
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({ db: "mock" })) }));
vi.mock("@/server/db/schema", () => ({
  users: {},
  accounts: {},
  sessions: {},
  verificationTokens: {},
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type AuthorizeFn = (credentials: { email: string; password: string }) => Promise<unknown>;

const loadAuthorize = async (): Promise<AuthorizeFn> => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const provider = authOptions.providers[0] as unknown as { authorize: AuthorizeFn };
  return provider.authorize;
};

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("credentials authorize — suspension signal (Step 6.5c)", () => {
  it("throws ACCOUNT_SUSPENDED (no user returned) when the service reports a suspended account", async () => {
    authenticateMock.mockResolvedValue({ status: "account_suspended" });
    const authorize = await loadAuthorize();

    await expect(
      authorize({ email: "user@example.com", password: "correct-password" }),
    ).rejects.toThrow("ACCOUNT_SUSPENDED");
  });

  it("keeps the generic INVALID_CREDENTIALS distinct from the suspended signal", async () => {
    authenticateMock.mockResolvedValue({ status: "invalid_credentials" });
    const authorize = await loadAuthorize();

    await expect(
      authorize({ email: "user@example.com", password: "wrong-password" }),
    ).rejects.toThrow("INVALID_CREDENTIALS");
  });

  it("returns the user object for a normal authenticated login", async () => {
    authenticateMock.mockResolvedValue({
      status: "authenticated",
      user: { id: "user_1", email: "user@example.com", role: "candidate" },
    });
    const authorize = await loadAuthorize();

    const user = await authorize({ email: "user@example.com", password: "correct-password" });

    expect(user).toEqual({ id: "user_1", email: "user@example.com", role: "candidate" });
  });
});
