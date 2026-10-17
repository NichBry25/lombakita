// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session callback compares the token's `signedInAtMs` claim with the account's live
// `sessions_invalid_before` stamp. These tests drive the real callbacks with a getDb mock whose
// SELECT returns a configurable row, so the stamp reaches the callback through the same projection
// production uses.

type AccountRow = {
  role: string | null;
  suspendedAt: Date | null;
  mfaInvalidatedAt: Date | null;
  hasVerifiedMfaFactor: boolean;
  sessionsInvalidBefore: Date | null;
};

const STAMP = new Date("2026-10-17T10:00:00.000Z");

const healthyRow = (sessionsInvalidBefore: Date | null): AccountRow => ({
  role: "candidate",
  suspendedAt: null,
  mfaInvalidatedAt: null,
  hasVerifiedMfaFactor: false,
  sessionsInvalidBefore,
});

let accountRow: AccountRow = healthyRow(null);

const limitMock = vi.fn(async () => [accountRow]);
const selectMock = vi.fn(() => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: limitMock,
    }),
  }),
}));
const getDbMock = vi.fn(() => ({ select: selectMock }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
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
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/auth/credentials-auth", () => ({ authenticateWithEmailPassword: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: getDbMock }));
vi.mock("@/server/db/schema", () => ({
  users: {
    id: "id",
    role: "role",
    suspendedAt: "suspended_at",
    candidateVerifiedAt: "c",
    recruiterVerifiedAt: "r",
    mfaInvalidatedAt: "mfa_invalidated_at",
    sessionsInvalidBefore: "sessions_invalid_before",
  },
  mfaFactors: { userId: "user_id", verifiedAt: "verified_at" },
  accounts: {},
  sessions: {},
  verificationTokens: {},
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
  session: { user?: Record<string, unknown>; expires: string };
  token: Record<string, unknown>;
}) => Promise<{ user?: Record<string, unknown>; expires?: string }>;

type JwtCb = (args: {
  token: Record<string, unknown>;
  user?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const callSession = async (token: Record<string, unknown>) => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const callback = authOptions.callbacks?.session as unknown as SessionCb;
  // `expires` is on every session next-auth hands the callback; without it a revoked session that
  // kept only `{ expires }` would be indistinguishable from the empty object.
  return callback({
    session: { user: { email: "a@seed.lombakita.local" }, expires: "2026-11-16T10:00:00.000Z" },
    token,
  });
};

const callJwtOnSignIn = async () => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const callback = authOptions.callbacks?.jwt as unknown as JwtCb;
  return callback({
    token: { sub: "user_123" },
    user: { id: "user_123", role: "candidate" },
  });
};

const callJwtOnRefresh = async (token: Record<string, unknown>) => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const callback = authOptions.callbacks?.jwt as unknown as JwtCb;
  return callback({ token });
};

const tokenSignedInAt = (signedInAtMs: number | undefined) => ({
  sub: "user_123",
  role: "candidate",
  verifiedRoles: ["candidate"],
  ...(signedInAtMs === undefined ? {} : { signedInAtMs }),
});

beforeEach(() => {
  accountRow = healthyRow(null);
});

afterEach(() => {
  vi.clearAllMocks();
  limitMock.mockImplementation(async () => [accountRow]);
  vi.useRealTimers();
  vi.resetModules();
});

describe("session callback — session revocation", () => {
  it("returns an empty object for a token signed in before the stamp", async () => {
    accountRow = healthyRow(STAMP);

    const result = await callSession(tokenSignedInAt(STAMP.getTime() - 1000));

    expect(Object.keys(result)).toHaveLength(0);
  });

  it("keeps the session for a token signed in after the stamp", async () => {
    accountRow = healthyRow(STAMP);

    const result = await callSession(tokenSignedInAt(STAMP.getTime() + 1000));

    expect(result.user?.id).toBe("user_123");
    expect(result.user?.role).toBe("candidate");
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("leaves a token with no claim unchanged while the account has no stamp", async () => {
    accountRow = healthyRow(null);

    const result = await callSession(tokenSignedInAt(undefined));

    expect(result.user?.id).toBe("user_123");
  });

  it("revokes a token with no claim once the account has a stamp", async () => {
    accountRow = healthyRow(STAMP);

    const result = await callSession(tokenSignedInAt(undefined));

    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns an empty object when the account read yields no stamp field at all", async () => {
    accountRow = {
      ...healthyRow(null),
      sessionsInvalidBefore: undefined as unknown as Date | null,
    };

    const result = await callSession(tokenSignedInAt(STAMP.getTime() + 1000));

    expect(Object.keys(result)).toHaveLength(0);
  });

  it("projects the stamp in the same select as the rest of the live account read", async () => {
    await callSession(tokenSignedInAt(STAMP.getTime()));

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionsInvalidBefore: expect.anything() }),
    );
    expect(limitMock).toHaveBeenCalledTimes(1);
  });
});

describe("jwt callback — sign-in claim", () => {
  it("stamps signedInAtMs within 5 seconds of now when a user signs in", async () => {
    const before = Date.now();

    const token = await callJwtOnSignIn();

    expect(typeof token.signedInAtMs).toBe("number");
    expect(Math.abs((token.signedInAtMs as number) - before)).toBeLessThan(5000);
  });

  it("keeps the sign-in instant across a refresh, so a password change made afterwards still revokes the token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T09:00:00.000Z"));
    const signedIn = await callJwtOnSignIn();
    const signedInAtMs = signedIn.signedInAtMs as number;
    expect(signedInAtMs).toBe(new Date("2026-10-17T09:00:00.000Z").getTime());

    accountRow = healthyRow(STAMP);
    vi.setSystemTime(new Date("2026-10-17T10:05:00.000Z"));
    const refreshed = await callJwtOnRefresh(signedIn);
    const result = await callSession(refreshed);

    expect(refreshed.signedInAtMs).toBe(signedInAtMs);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
