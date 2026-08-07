// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuthenticatedSession } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));

import { MfaError } from "./mfa-core";
import { withMfaRouteAuth } from "./mfa-route-guard";

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
    const handler = vi.fn().mockRejectedValue(
      new MfaError("mfa_invalid_code", 401, "Invalid verification code", 900),
    );

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
    const handler = vi.fn().mockRejectedValue(
      new MfaError("mfa_invalid_code", 401, "Invalid verification code"),
    );

    const response = await withMfaRouteAuth(handler)(makeRequest());
    const body = await response.json();

    // Present-but-null would read as a lockout of unknown length to any caller checking presence.
    expect(body.error).not.toHaveProperty("retryAfterSeconds");
    expect(response.headers.get("retry-after")).toBeNull();
  });
});
