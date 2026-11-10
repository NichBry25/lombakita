// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAuthenticatedSession, loggerErrorMock } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedSession,
  requireSessionRole: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
}));

import { withApiAuth } from "@/server/auth/api-guard";

const candidateSessionFixture = {
  user: {
    id: "user_1",
    role: "candidate",
    email: "candidate@example.com",
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

describe("withApiAuth — a handler that fails unexpectedly", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs the error class before answering the fixed 500, and neither carries the message", async () => {
    requireAuthenticatedSession.mockResolvedValue(candidateSessionFixture);
    const route = withApiAuth(() => {
      throw new Error("Failed query: x\nparams: secret-value\n    at secret-value");
    });

    const response = await route(new Request("http://localhost/api/v1/example") as never);
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({
      error: {
        code: "access_guard_failed",
        message: "Unexpected access-guard failure",
      },
    });
    expect(bodyText).not.toContain("secret-value");
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "unexpected error in an access-guarded route",
      expect.objectContaining({ errorClass: "Error" }),
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain("secret-value");
  });
});
