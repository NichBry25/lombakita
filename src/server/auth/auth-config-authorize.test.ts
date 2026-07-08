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
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

// Step 6.5-HARDENING.1 — the failed-attempt limiter gates authorize before any password work.
// Mocked so tests can drive the over-limit branch and assert record-on-fail / clear-on-success.
const { isFailedAttemptLimitedMock, recordFailedAttemptMock, clearFailedAttemptsMock } = vi.hoisted(
  () => ({
    isFailedAttemptLimitedMock: vi.fn(async () => false as boolean),
    recordFailedAttemptMock: vi.fn(async () => undefined),
    clearFailedAttemptsMock: vi.fn(async () => undefined),
  }),
);
vi.mock("@/server/redis/rate-limit", () => ({
  isFailedAttemptLimited: isFailedAttemptLimitedMock,
  recordFailedAttempt: recordFailedAttemptMock,
  clearFailedAttempts: clearFailedAttemptsMock,
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({ db: "mock" })) }));
vi.mock("@/server/db/schema", () => ({
  users: {},
  accounts: {},
  sessions: {},
  verificationTokens: {},
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type AuthorizeReq = { headers?: Record<string, string> };
type AuthorizeFn = (
  credentials: { email: string; password: string },
  req?: AuthorizeReq,
) => Promise<unknown>;

// A req carrying a resolvable client IP so the failed-attempt limiter is actually enforced (the
// limiter is skipped when the IP resolves to the "unknown" sentinel — see auth.config.ts).
const reqWithIp: AuthorizeReq = { headers: { "x-forwarded-for": "203.0.113.9" } };

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

describe("credentials authorize — failed-attempt rate limit (Step 6.5-HARDENING.1)", () => {
  it("throws RATE_LIMITED and never runs the password check when over the limit", async () => {
    isFailedAttemptLimitedMock.mockResolvedValueOnce(true);
    const authorize = await loadAuthorize();

    await expect(
      authorize({ email: "user@example.com", password: "correct-password" }, reqWithIp),
    ).rejects.toThrow("RATE_LIMITED");
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it("records a failed attempt on invalid credentials", async () => {
    authenticateMock.mockResolvedValue({ status: "invalid_credentials" });
    const authorize = await loadAuthorize();

    await expect(
      authorize({ email: "user@example.com", password: "wrong-password" }, reqWithIp),
    ).rejects.toThrow("INVALID_CREDENTIALS");
    expect(recordFailedAttemptMock).toHaveBeenCalledTimes(1);
    expect(clearFailedAttemptsMock).not.toHaveBeenCalled();
  });

  it("clears the counter on a successful login and records nothing", async () => {
    authenticateMock.mockResolvedValue({
      status: "authenticated",
      user: { id: "user_1", email: "user@example.com", role: "candidate" },
    });
    const authorize = await loadAuthorize();

    await authorize({ email: "user@example.com", password: "correct-password" }, reqWithIp);

    expect(clearFailedAttemptsMock).toHaveBeenCalledTimes(1);
    expect(recordFailedAttemptMock).not.toHaveBeenCalled();
  });

  it("skips the lockout entirely when the client IP is unresolvable (no global-email bucket)", async () => {
    isFailedAttemptLimitedMock.mockResolvedValue(true);
    authenticateMock.mockResolvedValue({
      status: "authenticated",
      user: { id: "user_1", email: "user@example.com", role: "candidate" },
    });
    const authorize = await loadAuthorize();

    // No req → IP resolves to the "unknown" sentinel → limiter is not consulted, correct password
    // still authenticates even though the mock would report over-limit.
    const user = await authorize({ email: "user@example.com", password: "correct-password" });

    expect(user).toEqual({ id: "user_1", email: "user@example.com", role: "candidate" });
    expect(isFailedAttemptLimitedMock).not.toHaveBeenCalled();
    expect(recordFailedAttemptMock).not.toHaveBeenCalled();
    expect(clearFailedAttemptsMock).not.toHaveBeenCalled();
  });
});
