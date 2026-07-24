// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const drizzleAdapterMock = vi.fn(() => ({ adapter: "mock" }));
const credentialsProviderMock = vi.fn((config: unknown) => config);
const getDbMock = vi.fn(() => ({ db: "mock" }));

vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: drizzleAdapterMock,
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: credentialsProviderMock,
}));

vi.mock("@/config/env", () => ({
  publicEnv: {
    appUrl: "http://localhost:3000",
  },
}));

vi.mock("@/config/env.server", () => ({
  assertRuntimeEnv: vi.fn(),
  serverEnv: {
    resendApiKey: "resend-key",
    authEmailFrom: "noreply@example.com",
    databaseUrl: "postgresql://local",
    authSecret: "auth-secret",
    authUrl: "http://localhost:3000",
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/server/auth/credentials-auth", () => ({
  authenticateWithEmailPassword: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDb: getDbMock,
}));

vi.mock("@/server/db/schema", () => ({
  users: { __name: "users" },
  accounts: { __name: "accounts" },
  sessions: { __name: "sessions" },
  verificationTokens: { __name: "verificationTokens" },
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

vi.mock("@/server/runtime/assert-server-only", () => ({
  assertServerOnly: vi.fn(),
}));

describe("auth.config", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("uses jwt session strategy for credentials flow (DEC-0015 preserved)", async () => {
    const { authOptions } = await import("@/server/auth/auth.config");

    expect(authOptions.session?.strategy).toBe("jwt");
  });

  it("configures a long-lived session cookie with refresh-on-activity (DEC-0049)", async () => {
    const { authOptions, PERSISTENT_SESSION_MAX_AGE_SECONDS } =
      await import("@/server/auth/auth.config");

    expect(PERSISTENT_SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 365);
    expect(authOptions.session?.maxAge).toBe(PERSISTENT_SESSION_MAX_AGE_SECONDS);
    // updateAge controls how often the cookie is rewritten on session reads; a 24h refresh
    // window produces "session survives idle if the user returns at least once per maxAge".
    expect(authOptions.session?.updateAge).toBe(60 * 60 * 24);
    expect(authOptions.jwt?.maxAge).toBe(PERSISTENT_SESSION_MAX_AGE_SECONDS);
  });

  it("keeps adapter-backed auth persistence tables configured", async () => {
    await import("@/server/auth/auth.config");

    expect(getDbMock).toHaveBeenCalledTimes(1);
    expect(drizzleAdapterMock).toHaveBeenCalledTimes(1);
    expect(drizzleAdapterMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        usersTable: expect.any(Object),
        accountsTable: expect.any(Object),
        sessionsTable: expect.any(Object),
        verificationTokensTable: expect.any(Object),
      }),
    );
  });
});
