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

  it("registers a candidate when ?as=candidate is supplied", async () => {
    registerUserWithCredentials.mockResolvedValue({
      email: "candidate@example.com",
      verificationRequired: true,
      alreadyVerified: false,
    });

    const request = new Request("http://localhost/api/v1/auth/register?as=candidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Candidate",
        email: "candidate@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registration.email).toBe("candidate@example.com");
    expect(registerUserWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ signupRole: "candidate" }),
    );
  });

  it("registers a recruiter when ?as=recruiter is supplied", async () => {
    registerUserWithCredentials.mockResolvedValue({
      email: "recruiter@example.com",
      verificationRequired: true,
      alreadyVerified: false,
    });

    const request = new Request("http://localhost/api/v1/auth/register?as=recruiter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Recruiter",
        email: "recruiter@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(registerUserWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ signupRole: "recruiter" }),
    );
  });

  it("rejects signup with no role declaration", async () => {
    registerUserWithCredentials.mockRejectedValue(
      new CredentialsAuthError(
        "invalid_signup_role",
        400,
        "Signup role declaration is required: use ?as=candidate or ?as=recruiter",
      ),
    );

    const request = new Request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Anonymous",
        email: "anon@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_signup_role");
  });

  it("rejects signup with an unknown ?as= value", async () => {
    const request = new Request("http://localhost/api/v1/auth/register?as=ghost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Anonymous",
        email: "anon@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_signup_role");
    expect(registerUserWithCredentials).not.toHaveBeenCalled();
  });

  it("maps known auth errors to response envelope", async () => {
    registerUserWithCredentials.mockRejectedValue(
      new CredentialsAuthError("email_exists", 409, "An account with this email already exists"),
    );

    const request = new Request("http://localhost/api/v1/auth/register?as=candidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Candidate",
        email: "candidate@example.com",
        password: "very-strong-password",
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("email_exists");
  });
});
