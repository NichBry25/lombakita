// @vitest-environment node
//
// Step 6.5d — auth.config signIn-callback wiring. Verifies the callback passes non-Google
// providers through (true) and delegates Google to resolveGoogleOAuthSignIn, and that the provider
// set is correct: providers[0] stays the email-password credentials login provider, the
// oauth-finalize provider exists, and the Google provider is registered only when configured.

import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGoogleOAuthSignIn = vi.fn();
const googleProviderMock = vi.fn((c: unknown) => ({ id: "google", ...(c as object) }));

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({ adapter: "mock" })) }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn((c: unknown) => c) }));
vi.mock("next-auth/providers/google", () => ({ default: googleProviderMock }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "http://localhost:3000" } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/server/auth/credentials-auth", () => ({ authenticateWithEmailPassword: vi.fn() }));
vi.mock("@/server/auth/oauth-account", () => ({
  GOOGLE_PROVIDER_ID: "google",
  OAUTH_FINALIZE_PROVIDER_ID: "oauth-finalize",
  resolveGoogleOAuthSignIn,
  authorizeOAuthFinalize: vi.fn(),
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({ db: "mock" })) }));
vi.mock("@/server/db/schema", () => ({
  users: {},
  accounts: {},
  sessions: {},
  verificationTokens: {},
  // Step 7.1-MFA: see the identical comment in auth-config-authorize.test.ts.
  mfaFactors: { userId: "user_id", verifiedAt: "verified_at" },
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

type SignInCb = (args: {
  account?: { provider?: string; providerAccountId?: string } | null;
  profile?: Record<string, unknown>;
  user?: Record<string, unknown>;
}) => Promise<unknown>;

const setEnv = (overrides: Record<string, unknown> = {}) => {
  vi.doMock("@/config/env.server", () => ({
    assertRuntimeEnv: vi.fn(),
    serverEnv: {
      resendApiKey: "k",
      authEmailFrom: "noreply@example.com",
      databaseUrl: "postgresql://local",
      authSecret: "secret",
      authUrl: "http://localhost:3000",
      ...overrides,
    },
  }));
};

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("@/config/env.server");
});

describe("auth.config — Google sign-in wiring (Step 6.5d)", () => {
  it("passes credentials sign-in through (returns true, no delegation)", async () => {
    setEnv();
    const { authOptions } = await import("@/server/auth/auth.config");
    const signIn = authOptions.callbacks?.signIn as unknown as SignInCb;

    const result = await signIn({
      account: { provider: "credentials", providerAccountId: "u1" },
      user: { id: "u1" },
    });

    expect(result).toBe(true);
    expect(resolveGoogleOAuthSignIn).not.toHaveBeenCalled();
  });

  it("delegates Google sign-in to resolveGoogleOAuthSignIn and returns its outcome", async () => {
    setEnv();
    resolveGoogleOAuthSignIn.mockResolvedValue("/auth/login?oauth=abc");
    const { authOptions } = await import("@/server/auth/auth.config");
    const signIn = authOptions.callbacks?.signIn as unknown as SignInCb;

    const result = await signIn({
      account: { provider: "google", providerAccountId: "google-sub-1" },
      profile: { email: "new@example.com", email_verified: true, name: "New" },
    });

    expect(result).toBe("/auth/login?oauth=abc");
    expect(resolveGoogleOAuthSignIn).toHaveBeenCalledWith({
      providerAccountId: "google-sub-1",
      email: "new@example.com",
      googleEmailVerified: true,
      name: "New",
      image: null,
    });
  });

  it("keeps providers[0] as the email-password credentials login provider", async () => {
    setEnv();
    const { authOptions } = await import("@/server/auth/auth.config");
    const first = authOptions.providers[0] as unknown as { name?: string };
    expect(first.name).toBe("email-password");
  });

  it("registers the Google provider only when configured", async () => {
    setEnv({ googleClientId: undefined, googleClientSecret: undefined });
    const { authOptions, isGoogleAuthConfigured } = await import("@/server/auth/auth.config");
    expect(isGoogleAuthConfigured).toBe(false);
    // email-password + oauth-finalize only.
    expect(authOptions.providers).toHaveLength(2);
  });

  it("includes the Google provider when both client id and secret are present", async () => {
    setEnv({ googleClientId: "gid", googleClientSecret: "gsecret" });
    const { authOptions, isGoogleAuthConfigured } = await import("@/server/auth/auth.config");
    expect(isGoogleAuthConfigured).toBe(true);
    expect(authOptions.providers).toHaveLength(3);
    expect(googleProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowDangerousEmailAccountLinking: true }),
    );
  });
});
