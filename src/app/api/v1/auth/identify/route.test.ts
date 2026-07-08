// @vitest-environment node
//
// Step 6.5-HARDENING.1 — the identify endpoint (an acknowledged email-enumeration oracle) is per-IP
// rate-limited BEFORE classification. These tests assert the 429 + Retry-After on breach (with no
// classification run) and normal pass-through when under the limit.

import { afterEach, describe, expect, it, vi } from "vitest";

const { checkFixedWindowLimitMock, classifyEmailForLoginMock } = vi.hoisted(() => ({
  checkFixedWindowLimitMock: vi.fn(),
  classifyEmailForLoginMock: vi.fn(),
}));

vi.mock("@/server/redis/rate-limit", () => ({
  checkFixedWindowLimit: checkFixedWindowLimitMock,
}));
vi.mock("@/server/auth/credentials-auth", () => ({
  classifyEmailForLogin: classifyEmailForLoginMock,
  CredentialsAuthError: class CredentialsAuthError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { POST } from "@/app/api/v1/auth/identify/route";

const makeRequest = (email: string): Request =>
  new Request("http://localhost/api/v1/auth/identify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ email }),
  });

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/auth/identify — rate limit gate", () => {
  it("returns 429 + Retry-After and does NOT classify when the per-IP window is exceeded", async () => {
    checkFixedWindowLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await POST(makeRequest("user@example.com"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(classifyEmailForLoginMock).not.toHaveBeenCalled();
  });

  it("classifies normally when under the limit", async () => {
    checkFixedWindowLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    classifyEmailForLoginMock.mockResolvedValue({ state: "none" });

    const response = await POST(makeRequest("user@example.com"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "none" });
    expect(classifyEmailForLoginMock).toHaveBeenCalledWith("user@example.com");
  });
});
