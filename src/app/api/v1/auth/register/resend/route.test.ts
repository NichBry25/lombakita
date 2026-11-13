// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

const { resendRegistrationVerification } = vi.hoisted(() => ({
  resendRegistrationVerification: vi.fn(),
}));

vi.mock("@/server/auth/credentials-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/credentials-auth")>();

  return {
    ...actual,
    resendRegistrationVerification,
  };
});

import { POST } from "@/app/api/v1/auth/register/resend/route";

describe("POST /api/v1/auth/register/resend", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resends verification email for pending account", async () => {
    resendRegistrationVerification.mockResolvedValue({
      email: "student@example.com",
    });

    const request = new Request("http://localhost/api/v1/auth/register/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "student@example.com",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resend.email).toBe("student@example.com");
  });

  it("returns proper error envelope for known auth errors", async () => {
    resendRegistrationVerification.mockRejectedValue(
      new CredentialsAuthError("verification_required", 404, "Registration record not found"),
    );

    const request = new Request("http://localhost/api/v1/auth/register/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "missing@example.com",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("verification_required");
  });
});
