// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { reportUnexpectedErrorMock } = vi.hoisted(() => ({ reportUnexpectedErrorMock: vi.fn() }));
vi.mock("@/server/observability/report-unexpected-error", () => ({
  reportUnexpectedError: reportUnexpectedErrorMock,
}));

import { CredentialsAuthError } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";

describe("toCredentialsAuthErrorResponse — unexpected errors", () => {
  it("reports an error that is not a CredentialsAuthError and answers the fixed 500", async () => {
    reportUnexpectedErrorMock.mockClear();
    const error = new Error("Failed query: x\nparams: secret-value");

    const response = toCredentialsAuthErrorResponse(error);

    expect(reportUnexpectedErrorMock).toHaveBeenCalledWith("an authentication route", error);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_unexpected_error",
        message: "Unexpected authentication error",
      },
    });
  });

  it("does not report a CredentialsAuthError", () => {
    reportUnexpectedErrorMock.mockClear();

    toCredentialsAuthErrorResponse(
      new CredentialsAuthError("verification_code_invalid", 400, "Kode verifikasi salah."),
    );

    expect(reportUnexpectedErrorMock).not.toHaveBeenCalled();
  });
});
