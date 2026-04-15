// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

const { registerUserWithCredentials } = vi.hoisted(() => ({
  registerUserWithCredentials: vi.fn(),
}));

vi.mock("@/server/auth/credentials-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/credentials-auth")>();

  return {
    ...actual,
    registerUserWithCredentials,
  };
});

import { POST } from "@/app/api/v1/auth/register/route";

describe("POST /api/v1/auth/register", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns registration payload for valid request", async () => {
    registerUserWithCredentials.mockResolvedValue({
      email: "student@example.com",
      verificationRequired: true,
      alreadyVerified: false,
    });

    const request = new Request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Student",
        email: "student@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registration.email).toBe("student@example.com");
  });

  it("maps known auth errors to response envelope", async () => {
    registerUserWithCredentials.mockRejectedValue(
      new CredentialsAuthError("email_exists", 409, "An account with this email already exists"),
    );

    const request = new Request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Student",
        email: "student@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("email_exists");
  });
});
