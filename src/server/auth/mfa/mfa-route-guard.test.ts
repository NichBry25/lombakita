// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireAuthenticatedSession, checkFixedWindowLimitFailClosed } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  checkFixedWindowLimitFailClosed: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimitFailClosed }));

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { MFA_ROUTE_RATE_LIMIT } from "@/server/auth/rate-limit-constants";
import { MfaError } from "./mfa-core";
import { withMfaRouteAuth } from "./mfa-route-guard";

// Every test below that expects the handler to RUN needs the limiter to allow, so the default is
// set fresh in beforeEach rather than once — `vi.clearAllMocks()` in the existing afterEach wipes
// mock implementations, and a limiter returning `undefined` would throw inside the guard and turn
// every unrelated assertion into a confusing 500.
beforeEach(() => {
  checkFixedWindowLimitFailClosed.mockResolvedValue({ decision: "allowed" });
});

const opsSession = {
  user: {
    id: "ops_1",
    role: "platform_ops",
    email: "ops@example.com",
    verifiedRoles: [],
    mfaStatus: "challenge_required",
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/auth/mfa/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ code: "123456" }),
  }) as never;

describe("withMfaRouteAuth — cross-session guard (CLAUDE.md Rule 16)", () => {
  afterEach(() => vi.clearAllMocks());

  it("refuses 409 when X-Expected-User-Id names a different account than the session", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await withMfaRouteAuth(handler)(
      makeRequest({ "x-expected-user-id": "ops_2" }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    // The point of the guard: the mutation must never run. A 409 after the factor moved would be
    // an error message attached to a completed write.
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler when the header agrees with the session", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await withMfaRouteAuth(handler)(
      makeRequest({ "x-expected-user-id": "ops_1" }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs the handler when no header is sent, matching the guard's backward-compatible contract", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await withMfaRouteAuth(handler)(makeRequest());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a self-service account before the cross-session check is reached", async () => {
    requireAuthenticatedSession.mockResolvedValue({
      ...opsSession,
      user: { ...opsSession.user, role: "candidate" },
    });
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    // Header agrees, so only the role gate can refuse this — pinning that the role gate still runs
    // first and that the Rule 16 check did not displace it.
    const response = await withMfaRouteAuth(handler)(
      makeRequest({ "x-expected-user-id": "ops_1" }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withMfaRouteAuth — lockout duration reaches the caller", () => {
  afterEach(() => vi.clearAllMocks());

  it("carries retryAfterSeconds and Retry-After on the invalid-code attempt that engaged the lock", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi
      .fn()
      .mockRejectedValue(new MfaError("mfa_invalid_code", 401, "Invalid verification code", 900));

    const response = await withMfaRouteAuth(handler)(makeRequest());
    const body = await response.json();

    // The code is unchanged — that attempt was a wrong code — but without the duration travelling
    // with it the form has no way to tell the operator the account just locked.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("mfa_invalid_code");
    expect(body.error.retryAfterSeconds).toBe(900);
    expect(response.headers.get("retry-after")).toBe("900");
  });

  it("omits both when the refusal has nothing to do with a lockout", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi
      .fn()
      .mockRejectedValue(new MfaError("mfa_invalid_code", 401, "Invalid verification code"));

    const response = await withMfaRouteAuth(handler)(makeRequest());
    const body = await response.json();

    // Present-but-null would read as a lockout of unknown length to any caller checking presence.
    expect(body.error).not.toHaveProperty("retryAfterSeconds");
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

// Every test here fails if the `assertUnderMfaRequestLimit` call is deleted from the
// wrapper: with no limiter the handler runs and the response is 200, so each assertion below flips.
describe("withMfaRouteAuth — fail-closed request limiting (MFA-D4)", () => {
  afterEach(() => vi.clearAllMocks());

  it("refuses 429 with Retry-After once the account is over the request ceiling", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    checkFixedWindowLimitFailClosed.mockResolvedValue({
      decision: "throttled",
      retryAfterSeconds: 42,
    });
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await withMfaRouteAuth(handler)(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("mfa_rate_limited");
    expect(body.error.retryAfterSeconds).toBe(42);
    expect(response.headers.get("retry-after")).toBe("42");
  });

  it("refuses 503 when Redis cannot confirm the request is under the ceiling", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    checkFixedWindowLimitFailClosed.mockResolvedValue({ decision: "unavailable" });
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await withMfaRouteAuth(handler)(makeRequest());
    const body = await response.json();

    // Fail-CLOSED. The DEC-0098 limiter would have allowed this through — which is precisely why it
    // could not be reused here.
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("mfa_rate_limit_unavailable");
    // Nothing to wait for: waiting does not restore Redis, and a Retry-After would say it does.
    expect(body.error).not.toHaveProperty("retryAfterSeconds");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("never reaches the handler on either refusal, so no database attempt budget is spent", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    checkFixedWindowLimitFailClosed.mockResolvedValue({
      decision: "throttled",
      retryAfterSeconds: 30,
    });
    await withMfaRouteAuth(handler)(makeRequest());

    checkFixedWindowLimitFailClosed.mockResolvedValue({ decision: "unavailable" });
    await withMfaRouteAuth(handler)(makeRequest());

    // The completion criterion in its most direct form. The handler is the only thing that opens
    // the transaction taking `FOR UPDATE` on the factor row and incrementing failed_attempt_count;
    // if it never runs, a throttled request cannot consume one of the five real attempts, and an
    // attacker cannot flood the endpoint to lock a legitimate operator out.
    expect(handler).not.toHaveBeenCalled();
  });

  it("keys the window on the resolved session's user id, not on anything the client sent", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    await withMfaRouteAuth(handler)(makeRequest({ "x-expected-user-id": "ops_1" }));

    expect(checkFixedWindowLimitFailClosed).toHaveBeenCalledWith({
      key: `${MFA_ROUTE_RATE_LIMIT.keyPrefix}ops_1`,
      limit: MFA_ROUTE_RATE_LIMIT.limit,
      windowSeconds: MFA_ROUTE_RATE_LIMIT.windowSeconds,
    });
  });

  it("logs the throttled decision, so sustained abuse is visible without an audit row", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    checkFixedWindowLimitFailClosed.mockResolvedValue({
      decision: "throttled",
      retryAfterSeconds: 30,
    });

    await withMfaRouteAuth(vi.fn())(makeRequest());

    // No audit row (Rule 7: platform_ops_audit_logs records ACTIONS, and letting refusals write
    // there would make the audit table growable by request volume). A structured log line is the
    // carrier instead — without it a step whose whole purpose is abuse resistance ships with the
    // abuse invisible.
    expect(loggerWarn).toHaveBeenCalledWith(
      "auth.mfa.rate_limited",
      expect.objectContaining({ userId: "ops_1", retryAfterSeconds: 30 }),
    );
  });

  it("logs when the limiter is unavailable, recording that an operator was refused", async () => {
    requireAuthenticatedSession.mockResolvedValue(opsSession);
    checkFixedWindowLimitFailClosed.mockResolvedValue({ decision: "unavailable" });

    await withMfaRouteAuth(vi.fn())(makeRequest());

    // The Redis degradation itself goes to Sentry from the primitive; this records the consequence,
    // which the primitive cannot know about.
    expect(loggerWarn).toHaveBeenCalledWith(
      "auth.mfa.rate_limiter_unavailable",
      expect.objectContaining({ userId: "ops_1" }),
    );
  });

  it("does not spend a slot on a request refused by the role gate or the cross-session guard", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok"));

    requireAuthenticatedSession.mockResolvedValue({
      ...opsSession,
      user: { ...opsSession.user, role: "candidate" },
    });
    await withMfaRouteAuth(handler)(makeRequest());

    requireAuthenticatedSession.mockResolvedValue(opsSession);
    await withMfaRouteAuth(handler)(makeRequest({ "x-expected-user-id": "ops_2" }));

    // Ordering, asserted from the other side: the limiter sits BELOW the identity checks, so a
    // request that was never going to be served cannot consume another account's budget — which is
    // what an attacker sending a mismatched header would otherwise be able to do.
    expect(checkFixedWindowLimitFailClosed).not.toHaveBeenCalled();
  });
});
