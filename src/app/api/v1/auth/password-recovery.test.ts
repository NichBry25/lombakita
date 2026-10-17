// @vitest-environment node

// THE THREE PASSWORD-RECOVERY ROUTES.
//
// The request route is an unauthenticated mail sender in front of an account lookup, so two things
// are pinned here. First, its two limiters stop the WORK rather than only reporting a 429 (CLASS C:
// the detector is that the lookup service is NOT CALLED). Second, nothing the caller can observe
// depends on the account: one body, one status, one 429.
//
// The limiter is the real one running over an in-memory fake of Redis, so the 11th request from one
// IP and the 4th for one address are refused by the actual windows rather than by a stubbed answer.
// Each refusal case seeds ONE counter past its ceiling and leaves the other untouched, so a case
// cannot pass because the other bound refused.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

const mocks = vi.hoisted(() => {
  const counters = new Map<string, number>();
  const countInto = async (key: string): Promise<number> => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  };
  const redis = {
    status: "ready",
    connect: vi.fn(),
    incr: vi.fn(countInto),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 1800),
    get: vi.fn(),
    del: vi.fn(),
  };

  return {
    counters,
    countInto,
    redis,
    redisUrl: { value: "redis://localhost:6379" as string | undefined },
    scheduled: [] as Array<() => unknown>,
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    changePassword: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendPasswordResetGoogleNoticeEmail: vi.fn(),
    sendPasswordChangedEmail: vi.fn(),
    getServerSession: vi.fn(),
    loggerError: vi.fn(),
    captureException: vi.fn(),
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => mocks.scheduled.push(task) };
});
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/config/env.server", () => ({
  assertRuntimeEnv: vi.fn(),
  get serverEnv() {
    return { redisUrl: mocks.redisUrl.value };
  },
}));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/redis/client", () => ({ getRedisClient: () => mocks.redis }));
vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/server/auth/password-reset", () => ({
  requestPasswordReset: mocks.requestPasswordReset,
  confirmPasswordReset: mocks.confirmPasswordReset,
  changePassword: mocks.changePassword,
}));
vi.mock("@/server/auth/password-reset-email", () => ({
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
  sendPasswordResetGoogleNoticeEmail: mocks.sendPasswordResetGoogleNoticeEmail,
  sendPasswordChangedEmail: mocks.sendPasswordChangedEmail,
}));
vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/server/auth/auth.config", () => ({ authOptions: {} }));

import { POST as changePost } from "@/app/api/v1/auth/password/change/route";
import { POST as confirmPost } from "@/app/api/v1/auth/password-reset/confirm/route";
import { POST as requestPost } from "@/app/api/v1/auth/password-reset/request/route";
import {
  PASSWORD_RESET_ADDRESS_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
} from "@/server/auth/rate-limit-constants";

const KNOWN = "ada@seed.lombakita.local";
const IP = "203.0.113.9";

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const requestFor = (email: unknown, ip: string | null = IP) =>
  postJson(
    "http://localhost/api/v1/auth/password-reset/request",
    { email },
    ip === null ? {} : { "x-forwarded-for": ip },
  );

const addressKey = (email: string) => `${PASSWORD_RESET_ADDRESS_LIMIT.keyPrefix}${email}`;
const ipKey = (ip: string) => `${PASSWORD_RESET_IP_LIMIT.keyPrefix}${ip}`;

const runScheduled = async () => {
  for (const task of mocks.scheduled.splice(0)) await task();
};

beforeEach(() => {
  mocks.counters.clear();
  mocks.redis.incr.mockImplementation(mocks.countInto);
  mocks.scheduled.length = 0;
  mocks.redisUrl.value = "redis://localhost:6379";
  mocks.requestPasswordReset.mockResolvedValue({ action: "none" });
  mocks.sendPasswordResetEmail.mockResolvedValue(undefined);
  mocks.sendPasswordResetGoogleNoticeEmail.mockResolvedValue(undefined);
  mocks.sendPasswordChangedEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/auth/password-reset/request", () => {
  it("answers { requested: true } with 200 for every kind of address", async () => {
    const outcomes = [
      { action: "none" },
      { action: "send_reset", userId: "u1", email: KNOWN, name: "Ada", rawToken: "t".repeat(64) },
      { action: "send_google_notice", userId: "u2", email: KNOWN, name: "Ada" },
    ];
    const answers: Array<{ status: number; body: unknown }> = [];

    for (const [index, outcome] of outcomes.entries()) {
      mocks.requestPasswordReset.mockResolvedValueOnce(outcome);
      const response = await requestPost(requestFor(`person${index}@seed.lombakita.local`));
      answers.push({ status: response.status, body: await response.json() });
    }

    expect(answers).toEqual([
      { status: 200, body: { requested: true } },
      { status: 200, body: { requested: true } },
      { status: 200, body: { requested: true } },
    ]);
  });

  it("sends a reset link only for the send_reset outcome, after the response is built", async () => {
    mocks.requestPasswordReset.mockResolvedValueOnce({
      action: "send_reset",
      userId: "u1",
      email: KNOWN,
      name: "Ada",
      rawToken: "t".repeat(64),
    });

    await requestPost(requestFor(KNOWN));

    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
    await runScheduled();
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledWith({
      email: KNOWN,
      name: "Ada",
      rawToken: "t".repeat(64),
    });
    expect(mocks.sendPasswordResetGoogleNoticeEmail).not.toHaveBeenCalled();
  });

  it("sends the Google notice only for the send_google_notice outcome", async () => {
    mocks.requestPasswordReset.mockResolvedValueOnce({
      action: "send_google_notice",
      userId: "u2",
      email: KNOWN,
      name: "Ada",
    });

    await requestPost(requestFor(KNOWN));
    await runScheduled();

    expect(mocks.sendPasswordResetGoogleNoticeEmail).toHaveBeenCalledWith({
      email: KNOWN,
      name: "Ada",
    });
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("sends nothing and schedules nothing for the none outcome", async () => {
    await requestPost(requestFor("nobody@seed.lombakita.local"));

    expect(mocks.scheduled).toHaveLength(0);
  });

  it("still answers 200 when the send fails, and reports it without the address or the token", async () => {
    const rawToken = "f".repeat(64);
    mocks.requestPasswordReset.mockResolvedValueOnce({
      action: "send_reset",
      userId: "u1",
      email: KNOWN,
      name: "Ada",
      rawToken,
    });
    mocks.sendPasswordResetEmail.mockRejectedValue(new Error(`provider refused ${KNOWN}`));

    const response = await requestPost(requestFor(KNOWN));
    await runScheduled();

    expect(response.status).toBe(200);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "auth.password_reset_email.dispatch_failed",
      expect.objectContaining({ userId: "u1", kind: "password_reset" }),
    );
    const reported = JSON.stringify([
      mocks.loggerError.mock.calls,
      mocks.captureException.mock.calls.map(([error]) => (error as Error).message),
    ]);
    expect(reported).not.toContain(KNOWN);
    expect(reported).not.toContain(rawToken);
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it("counts the IP and then the address, before it looks the address up", async () => {
    await requestPost(requestFor(KNOWN));

    expect(mocks.redis.incr.mock.calls.map(([key]) => key)).toEqual([ipKey(IP), addressKey(KNOWN)]);
  });

  it("keys and windows the two bounds at the literal policy values", async () => {
    // Literals, not the exported constants: a constant edited in step with its own test would
    // otherwise move both. Limits 10 and 3 are pinned by the 11th-request and 4th-request cases.
    await requestPost(requestFor(KNOWN));

    expect(mocks.redis.incr.mock.calls.map(([key]) => key)).toEqual([
      "rl:password-reset-ip:203.0.113.9",
      "rl:password-reset-addr:ada@seed.lombakita.local",
    ]);
    expect(mocks.redis.expire.mock.calls).toEqual([
      ["rl:password-reset-ip:203.0.113.9", 3600],
      ["rl:password-reset-addr:ada@seed.lombakita.local", 3600],
    ]);
  });

  it("refuses on the IP bound without looking the address up", async () => {
    // ONLY the IP counter is past its ceiling; the address counter is untouched, so a 429 here can
    // only have come from the IP bound.
    mocks.counters.set(ipKey(IP), PASSWORD_RESET_IP_LIMIT.limit);

    const response = await requestPost(requestFor(KNOWN));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1800");
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("refuses on the address bound without looking the address up", async () => {
    // ONLY the address counter is past its ceiling: the distributed-attacker case the IP key cannot
    // see.
    mocks.counters.set(addressKey(KNOWN), PASSWORD_RESET_ADDRESS_LIMIT.limit);

    const response = await requestPost(requestFor(KNOWN));

    expect(response.status).toBe(429);
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("refuses the 11th request from one IP", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < PASSWORD_RESET_IP_LIMIT.limit + 1; attempt += 1) {
      const response = await requestPost(requestFor(`n${attempt}@seed.lombakita.local`));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it("refuses the 4th request for one address, from different IPs", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < PASSWORD_RESET_ADDRESS_LIMIT.limit + 1; attempt += 1) {
      const response = await requestPost(requestFor(KNOWN, `198.51.100.${attempt + 1}`));
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("answers the same 429 whether or not the address has an account", async () => {
    mocks.counters.set(addressKey(KNOWN), PASSWORD_RESET_ADDRESS_LIMIT.limit);
    mocks.counters.set(
      addressKey("nobody@seed.lombakita.local"),
      PASSWORD_RESET_ADDRESS_LIMIT.limit,
    );

    const real = await requestPost(requestFor(KNOWN));
    const unknown = await requestPost(requestFor("nobody@seed.lombakita.local"));

    expect(real.status).toBe(unknown.status);
    expect(await real.json()).toEqual(await unknown.json());
    expect(real.headers.get("Retry-After")).toBe(unknown.headers.get("Retry-After"));
  });

  it("advances the address counter for an address with no account", async () => {
    await requestPost(requestFor("nobody@seed.lombakita.local"));

    expect(mocks.counters.get(addressKey("nobody@seed.lombakita.local"))).toBe(1);
  });

  it("skips only the IP bound when the client IP cannot be resolved", async () => {
    await requestPost(requestFor(KNOWN, null));

    expect(mocks.redis.incr.mock.calls.map(([key]) => key)).toEqual([addressKey(KNOWN)]);
  });

  it("allows the request when Redis is unavailable (fail open)", async () => {
    mocks.redis.incr.mockRejectedValue(new Error("redis down"));

    const response = await requestPost(requestFor(KNOWN));

    expect(response.status).toBe(200);
    expect(mocks.requestPasswordReset).toHaveBeenCalledOnce();
  });

  it("refuses a malformed address with 400, after the address has been counted", async () => {
    const response = await requestPost(requestFor("not-an-email"));

    expect(response.status).toBe(400);
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
    expect(mocks.counters.get(addressKey("not-an-email"))).toBe(1);
  });

  it("refuses a body that is not JSON with invalid_payload", async () => {
    const response = await requestPost(
      postJson("http://localhost/api/v1/auth/password-reset/request", "{", {
        "x-forwarded-for": IP,
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_payload");
  });
});

describe("POST /api/v1/auth/password-reset/confirm", () => {
  const confirmRequest = (body: unknown) =>
    postJson("http://localhost/api/v1/auth/password-reset/confirm", body);

  it("answers { reset: true } and schedules the password-changed email", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({ userId: "u1", email: KNOWN, name: "Ada" });

    const response = await confirmPost(confirmRequest({ token: "a".repeat(64), password: "x" }));
    await runScheduled();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true });
    expect(mocks.sendPasswordChangedEmail).toHaveBeenCalledWith({ email: KNOWN, name: "Ada" });
  });

  it("clears the sign-in lock for the device that completed the reset, at the literal key", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({
      userId: "u1",
      email: "Ada@Seed.Lombakita.Local",
      name: "Ada",
    });

    await confirmPost(
      postJson(
        "http://localhost/api/v1/auth/password-reset/confirm",
        { token: "a".repeat(64), password: "x" },
        { "x-forwarded-for": IP },
      ),
    );

    expect(mocks.redis.del).toHaveBeenCalledOnce();
    expect(mocks.redis.del).toHaveBeenCalledWith(`rl:login-fail:${IP}:${KNOWN}`);
  });

  it("clears nothing when the client IP is unresolvable, because sign-in keeps no lock then", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({ userId: "u1", email: KNOWN, name: "Ada" });

    await confirmPost(confirmRequest({ token: "a".repeat(64), password: "x" }));

    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it("clears nothing when the reset is refused", async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new CredentialsAuthError(
        "password_reset_token_invalid",
        400,
        "Tautan atur ulang tidak valid",
      ),
    );

    await confirmPost(
      postJson(
        "http://localhost/api/v1/auth/password-reset/confirm",
        { token: "a".repeat(64), password: "x" },
        { "x-forwarded-for": IP },
      ),
    );

    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it("is not behind a limiter", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({ userId: "u1", email: KNOWN, name: "Ada" });

    await confirmPost(confirmRequest({ token: "a".repeat(64), password: "x" }));

    expect(mocks.redis.incr).not.toHaveBeenCalled();
  });

  it("maps an invalid token to its error envelope and sends nothing", async () => {
    mocks.confirmPasswordReset.mockRejectedValue(
      new CredentialsAuthError(
        "password_reset_token_invalid",
        400,
        "Tautan atur ulang tidak valid",
      ),
    );

    const response = await confirmPost(confirmRequest({ token: "a".repeat(64), password: "x" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("password_reset_token_invalid");
    expect(mocks.scheduled).toHaveLength(0);
  });

  it("refuses a body that is not JSON with invalid_payload", async () => {
    const response = await confirmPost(
      postJson("http://localhost/api/v1/auth/password-reset/confirm", "{"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_payload");
  });
});

describe("POST /api/v1/auth/password/change", () => {
  const changeRequest = (body: unknown, headers: Record<string, string> = {}) =>
    postJson("http://localhost/api/v1/auth/password/change", body, headers);

  const signIn = (user: Record<string, unknown> = {}) =>
    mocks.getServerSession.mockResolvedValue({
      user: {
        id: "user_1",
        role: "candidate",
        verifiedRoles: ["candidate"],
        mfaStatus: "not_applicable",
        ...user,
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });

  const BODY = { currentPassword: "old-password-1", newPassword: "new-password-2" };

  it("refuses an operational session whose MFA is not satisfied, before the service runs", async () => {
    signIn({ role: "platform_ops", mfaStatus: "enrolment_required" });

    const response = await changePost(changeRequest(BODY) as never);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("mfa_enrolment_required");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mocks.getServerSession.mockResolvedValue(null);

    const response = await changePost(changeRequest(BODY) as never);

    expect(response.status).toBe(401);
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("refuses a form rendered for a different account (409)", async () => {
    signIn();

    const response = await changePost(
      changeRequest(BODY, { "x-expected-user-id": "someone_else" }) as never,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("session_user_mismatch");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("changes the password for the session user and schedules the email", async () => {
    signIn();
    mocks.changePassword.mockResolvedValue({ outcome: "changed", email: KNOWN, name: "Ada" });

    const response = await changePost(
      changeRequest(BODY, { "x-expected-user-id": "user_1" }) as never,
    );
    await runScheduled();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true });
    expect(mocks.changePassword).toHaveBeenCalledWith({
      userId: "user_1",
      currentPassword: "old-password-1",
      newPassword: "new-password-2",
    });
    expect(mocks.sendPasswordChangedEmail).toHaveBeenCalledWith({ email: KNOWN, name: "Ada" });
  });

  it("answers 429 with Retry-After when the account is limited", async () => {
    signIn();
    mocks.changePassword.mockResolvedValue({ outcome: "rate_limited", retryAfterSeconds: 420 });

    const response = await changePost(changeRequest(BODY) as never);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("420");
    expect(mocks.scheduled).toHaveLength(0);
  });

  it("answers 503 rate_limit_unavailable when Redis cannot confirm", async () => {
    signIn();
    mocks.changePassword.mockResolvedValue({ outcome: "limiter_unavailable" });

    const response = await changePost(changeRequest(BODY) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limit_unavailable",
        message: "Layanan sementara tidak tersedia. Coba lagi beberapa saat.",
      },
    });
  });

  it.each([
    ["invalid_current_password", 400, "Password saat ini salah."],
    ["password_not_set", 409, "Akun ini masuk dengan Google dan tidak memiliki password."],
  ] as const)("maps %s to its envelope", async (code, status, message) => {
    signIn();
    mocks.changePassword.mockRejectedValue(new CredentialsAuthError(code, status, message));

    const response = await changePost(changeRequest(BODY) as never);

    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject({ code, message });
  });

  it("refuses a body that is not a JSON object with invalid_payload", async () => {
    signIn();

    const response = await changePost(changeRequest([]) as never);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_payload");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });
});
