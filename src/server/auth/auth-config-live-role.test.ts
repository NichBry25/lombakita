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

const loggerWarnMock = vi.fn();
const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock }));

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
  logger: { error: vi.fn(), warn: loggerWarnMock, info: vi.fn() },
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
  limitMock.mockReset();
  limitMock.mockImplementation(async () => {
    if (queryOutcome.kind === "error") throw new Error("connection terminated unexpectedly");
    if (queryOutcome.kind === "empty") return [];
    return [queryOutcome.row];
  });
  vi.useRealTimers();
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

  it("refuses a cached recruiter role when the database is unreachable without ending the session", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("recruiter"));

    expect(result.user?.role).toBeUndefined();
    expect(result.user?.accountStateUnavailable).toBe(true);
    expect(result.user?.id).toBe("user_123");
  });

  it("refuses a cached candidate role when the database is unreachable", async () => {
    queryOutcome = { kind: "error" };

    const result = await callSession(tokenFor("candidate"));

    expect(result.user?.role).toBeUndefined();
    expect(result.user?.accountStateUnavailable).toBe(true);
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

    expect(loggerWarnMock).toHaveBeenCalledWith("auth.live-account-read.failed", {
      error: "Account status is temporarily unavailable",
    });
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

describe("live account read budget and retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
  });

  it("silently retries one rejection and returns the successful session", async () => {
    limitMock.mockRejectedValueOnce(new Error("first attempt rejected"));
    const result = await callSession(tokenFor("candidate"));
    expect(limitMock).toHaveBeenCalledTimes(2);
    expect(result.user?.role).toBe("candidate");
    expect(result.user?.accountStateUnavailable).toBeUndefined();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("allows the first attempt to resolve after 3000 ms", async () => {
    const { authOptions } = await import("@/server/auth/auth.config");
    const callback = authOptions.callbacks?.session as unknown as SessionCb;
    limitMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ role: "candidate", suspendedAt: null }]), 3000);
        }),
    );
    let result: { user?: Record<string, unknown> } | undefined;
    const pending = callback({ session: { user: {} }, token: tokenFor("candidate") });
    void pending.then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result?.user?.role).toBe("candidate");
    expect(result?.user?.accountStateUnavailable).toBeUndefined();
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("fails after two rejections and throttles anonymous error reporting per process", async () => {
    limitMock.mockRejectedValue(new Error("user_123 a@b.com token-secret failed query"));
    const result = await callSession(tokenFor("candidate"));
    expect(result.user?.accountStateUnavailable).toBe(true);
    expect(result.user?.role).toBeUndefined();
    expect(limitMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      level: "error",
      tags: { subsystem: "auth-live-account-read" },
    });
    const reported = captureExceptionMock.mock.calls[0]?.[0] as Error | undefined;
    if (!reported) throw new Error("Sentry event not captured");
    expect(reported.message).toBe("Account status is temporarily unavailable");
    expect(loggerWarnMock).toHaveBeenCalledWith("auth.live-account-read.failed", {
      error: "Account status is temporarily unavailable",
    });
    const events = JSON.stringify(captureExceptionMock.mock.calls) + reported.stack;
    const logs = JSON.stringify(loggerWarnMock.mock.calls);
    for (const identity of ["user_123", "a@b.com", "token-secret"]) {
      expect(events).not.toContain(identity);
      expect(logs).not.toContain(identity);
    }
    await vi.advanceTimersByTimeAsync(59999);
    await callSession({ ...tokenFor("recruiter"), sub: "different-user" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await callSession(tokenFor("candidate"));
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });

  it("ends a never-resolving read at 8000 ms without retrying the timeout", async () => {
    const { authOptions } = await import("@/server/auth/auth.config");
    const callback = authOptions.callbacks?.session as unknown as SessionCb;
    limitMock.mockImplementation(() => new Promise(() => {}));
    let result: { user?: Record<string, unknown> } | undefined;
    void callback({ session: { user: {} }, token: tokenFor("candidate") }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result?.user?.accountStateUnavailable).toBe(true);
    expect(result?.user?.role).toBeUndefined();
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("gives the retry only the remaining budget and consumes abandoned rejections", async () => {
    const { authOptions } = await import("@/server/auth/auth.config");
    const callback = authOptions.callbacks?.session as unknown as SessionCb;
    let rejectAbandoned: ((reason: Error) => void) | undefined;
    limitMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("first rejection")), 3000);
        }),
    );
    limitMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectAbandoned = reject;
        }),
    );
    let result: { user?: Record<string, unknown> } | undefined;
    void callback({ session: { user: {} }, token: tokenFor("candidate") }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(limitMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result?.user?.accountStateUnavailable).toBe(true);
    rejectAbandoned?.(new Error("late abandoned rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the cookie token intact and recovers on the next successful read", async () => {
    const token = tokenFor("candidate");
    const originalToken = { ...token };
    queryOutcome = { kind: "error" };
    const failed = await callSession(token);
    expect(failed.user?.accountStateUnavailable).toBe(true);
    expect(token).toEqual(originalToken);
    queryOutcome = { kind: "row", row: { role: "candidate", suspendedAt: null } };
    const recovered = await callSession(token);
    expect(recovered.user?.role).toBe("candidate");
    expect(recovered.user?.accountStateUnavailable).toBeUndefined();
    expect(token).toEqual(originalToken);
  });

  it.each(["platform_ops", "finance_ops", "reviewer_or_judge"])(
    "keeps %s fail closed after both rejections",
    async (role) => {
      queryOutcome = { kind: "error" };
      const result = await callSession(tokenFor(role));
      expect(result.user?.role).toBeUndefined();
      expect(result.user?.accountStateUnavailable).toBe(true);
    },
  );
});

it("does not let reporting failures throw out of the real session callback", async () => {
  queryOutcome = { kind: "error" };
  loggerWarnMock.mockImplementationOnce(() => {
    throw new Error("logger unavailable");
  });
  captureExceptionMock.mockImplementationOnce(() => {
    throw new Error("Sentry unavailable");
  });
  const result = await callSession(tokenFor("candidate"));
  expect(result.user?.accountStateUnavailable).toBe(true);
  expect(result.user?.role).toBeUndefined();
  expect(loggerWarnMock).toHaveBeenCalledOnce();
  expect(captureExceptionMock).toHaveBeenCalledOnce();
});

it("does not read account state without a token subject", async () => {
  const result = await callSession({});
  expect(result.user?.id).toBeUndefined();
  expect(limitMock).not.toHaveBeenCalled();
});

it("clears an existing session role after the live account read fails", async () => {
  queryOutcome = { kind: "error" };
  const { authOptions } = await import("@/server/auth/auth.config");
  const callback = authOptions.callbacks?.session as unknown as SessionCb;
  const result = await callback({
    session: { user: { role: "candidate" } },
    token: tokenFor("candidate"),
  });
  expect(result.user?.role).toBeUndefined();
  expect(result.user?.accountStateUnavailable).toBe(true);
});
