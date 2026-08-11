// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session callback resolves the account's role from the database on every session resolution
// rather than from the JWT, so a role change or an account deletion takes effect on the next
// request. These tests drive the callback directly with a getDb mock whose SELECT can return a
// row, return nothing (deleted account), or throw (database unreachable).
//
// The other half of the contract — that an absent session.user.role is rejected with
// AccessError("unauthenticated") — is covered in access-core.test.ts and is not duplicated here.

type QueryOutcome =
  | { kind: "row"; row: { role: string | null; suspendedAt: Date | null } }
  | { kind: "empty" }
  | { kind: "error" };

let queryOutcome: QueryOutcome = { kind: "row", row: { role: "candidate", suspendedAt: null } };

const loggerErrorMock = vi.fn();

const limitMock = vi.fn(async () => {
  if (queryOutcome.kind === "error") {
    throw new Error("connection terminated unexpectedly");
  }
  if (queryOutcome.kind === "empty") {
    return [];
  }
  return [queryOutcome.row];
});

// `select` is hoisted out of the factory so a test can assert WHICH columns are projected —
// silently dropping `role` from the query would otherwise leave every other test green while
// making every session roleless in production.
const selectMock = vi.fn(() => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: limitMock,
    }),
  }),
}));

const getDbMock = vi.fn(() => ({ select: selectMock }));

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
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() },
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
  },
  accounts: {},
  sessions: {},
  verificationTokens: {},
  // Step 7.1-MFA: auth.config.ts's loadLiveAccountState builds a correlated EXISTS subquery
  // referencing mfaFactors.userId/verifiedAt. A full-replacement schema mock without this key
  // throws "Cannot read properties of undefined" the moment the session callback runs.
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

const callSession = async (token: Record<string, unknown>) => {
  const { authOptions } = await import("@/server/auth/auth.config");
  const cb = authOptions.callbacks?.session as unknown as SessionCb;
  return cb({ session: { user: { email: "a@b.com" } }, token });
};

const tokenFor = (role: string) => ({
  sub: "user_123",
  role,
  verifiedRoles: ["candidate"],
});

beforeEach(() => {
  queryOutcome = { kind: "row", row: { role: "candidate", suspendedAt: null } };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("session callback — live role read", () => {
  it("surfaces the database role when it disagrees with the token (demotion takes effect)", async () => {
    queryOutcome = { kind: "row", row: { role: "candidate", suspendedAt: null } };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.role).toBe("candidate");
  });

  it("keeps platform_ops for an account whose database role is still platform_ops", async () => {
    queryOutcome = { kind: "row", row: { role: "platform_ops", suspendedAt: null } };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.role).toBe("platform_ops");
  });

  it("surfaces the database role when it is an upgrade the token has not seen", async () => {
    queryOutcome = { kind: "row", row: { role: "recruiter", suspendedAt: null } };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.role).toBe("recruiter");
  });

  it("surfaces no role when the account row no longer exists (deleted account)", async () => {
    queryOutcome = { kind: "empty" };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.role).toBeUndefined();
  });

  it("still sets verifiedRoles when the account row no longer exists", async () => {
    queryOutcome = { kind: "empty" };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.verifiedRoles).toEqual(["candidate"]);
  });

  it("falls back to the token role when the database is unreachable (no lockout)", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("recruiter"));

    expect(result.user?.role).toBe("recruiter");
  });

  it("falls back for a candidate when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.role).toBe("candidate");
  });

  it("refuses a cached platform_ops role when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.role).toBeUndefined();
  });

  it("refuses a cached finance_ops role when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("finance_ops"));

    expect(result.user?.role).toBeUndefined();
  });

  it("projects the role column so a dropped projection cannot pass silently", async () => {
    await callSession(tokenFor("candidate"));

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "role", suspendedAt: "suspended_at" }),
    );
  });

  it("still sets session.user.id when the account row no longer exists", async () => {
    queryOutcome = { kind: "empty" };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.id).toBe("user_123");
  });

  it("records the failure when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    await callSession(tokenFor("recruiter"));

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "auth.liveAccountState.load_failed",
      expect.objectContaining({ userId: "user_123" }),
    );
  });

  it("surfaces no role when the database value is not a recognised app role", async () => {
    queryOutcome = { kind: "row", row: { role: "institution_admin", suspendedAt: null } };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.role).toBeUndefined();
  });

  it("surfaces no role when the database value is null", async () => {
    queryOutcome = { kind: "row", row: { role: null, suspendedAt: null } };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.role).toBeUndefined();
  });

  it("reads the account exactly once per session resolution", async () => {
    await callSession(tokenFor("candidate"));

    expect(limitMock).toHaveBeenCalledTimes(1);
  });
});

describe("session callback — suspension alongside the live role", () => {
  it("surfaces suspendedAt and the live role together", async () => {
    queryOutcome = {
      kind: "row",
      row: { role: "candidate", suspendedAt: new Date("2026-06-02T00:00:00.000Z") },
    };

    const result = await callSession(tokenFor("platform_ops"));

    expect(result.user?.suspendedAt).toBe("2026-06-02T00:00:00.000Z");
    expect(result.user?.role).toBe("candidate");
  });

  it("leaves suspendedAt undefined when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.suspendedAt).toBeUndefined();
  });

  it("leaves suspendedAt undefined when the account row no longer exists", async () => {
    queryOutcome = { kind: "empty" };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.suspendedAt).toBeUndefined();
  });
});
