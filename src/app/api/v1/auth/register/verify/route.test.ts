// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";

const { checkFixedWindowLimit, verifyEmailCodeAndSetPassword } = vi.hoisted(() => ({
  checkFixedWindowLimit: vi.fn(),
  verifyEmailCodeAndSetPassword: vi.fn(),
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();

  return { ...actual, checkFixedWindowLimit };
});
vi.mock("@/server/auth/credentials-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/credentials-auth")>();

  return {
    ...actual,
    verifyEmailCodeAndSetPassword,
  };
});

import { POST } from "@/app/api/v1/auth/register/verify/route";

const ADDRESS = "rina.code@example.test";

const verifyRequest = (body: string) =>
  new Request("http://localhost/api/v1/auth/register/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
    },
    body,
  });

const validBody = JSON.stringify({ email: ADDRESS, code: "123456", password: "owner-pass-2" });

beforeEach(() => {
  checkFixedWindowLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/auth/register/verify", () => {
  it("answers 429 from the IP bound before the service runs", async () => {
    checkFixedWindowLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(verifyRequest(validBody));

    expect(response.status).toBe(429);
    expect(verifyEmailCodeAndSetPassword).not.toHaveBeenCalled();
  });

  it("returns the verified email for a valid body", async () => {
    verifyEmailCodeAndSetPassword.mockResolvedValue({ email: ADDRESS });

    const response = await POST(verifyRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ verify: { email: ADDRESS } });
  });

  it("answers a service refusal with its status and code", async () => {
    verifyEmailCodeAndSetPassword.mockRejectedValue(
      new CredentialsAuthError(
        "verification_code_invalid",
        400,
        "Kode verifikasi salah atau sudah tidak berlaku.",
      ),
    );

    const response = await POST(verifyRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("verification_code_invalid");
  });

  it("answers 400 invalid_payload for a body that is not JSON", async () => {
    const response = await POST(verifyRequest("{not json"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_payload");
    expect(verifyEmailCodeAndSetPassword).not.toHaveBeenCalled();
  });
});
