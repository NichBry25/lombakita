// @vitest-environment node

import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

const { registerUserWithCredentials, loggerErrorMock } = vi.hoisted(() => ({
  registerUserWithCredentials: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: loggerErrorMock, info: vi.fn() },
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

  it("hands the return address in the body to the service", async () => {
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
        callbackUrl: "/competitions/acme/lomba-1",
      }),
    });

    await POST(request);

    expect(registerUserWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: "/competitions/acme/lomba-1" }),
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

  it("answers a database failure with the fixed 500 and keeps its query and params out of the body and the log", async () => {
    registerUserWithCredentials.mockRejectedValue(
      new DrizzleQueryError(
        'insert into "users" ("email","password_hash") values ($1, $2)',
        ["a@b.c", "$2b$12$secrethashvalue"],
        new Error("duplicate"),
      ),
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
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText).error.code).toBe("auth_unexpected_error");
    expect(bodyText).not.toContain("password_hash");
    expect(bodyText).not.toContain("secrethashvalue");
    const loggedCalls = inspect(loggerErrorMock.mock.calls, { depth: null });
    expect(loggedCalls).not.toContain("password_hash");
    expect(loggedCalls).not.toContain("secrethashvalue");
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith("route.unexpected_error", expect.anything());
  });
});
