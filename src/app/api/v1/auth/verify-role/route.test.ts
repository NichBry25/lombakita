// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getServerSessionMock, markRoleAsVerifiedStubMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn<() => Promise<Session | null>>(),
  markRoleAsVerifiedStubMock: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/server/auth/auth.config", () => ({
  authOptions: {},
}));

vi.mock("@/server/auth/role-verification", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/auth/role-verification")>();
  return {
    ...actual,
    markRoleAsVerifiedStub: markRoleAsVerifiedStubMock,
  };
});

import { POST } from "@/app/api/v1/auth/verify-role/route";
import { RoleVerificationError } from "@/server/auth/role-verification";

const buildSession = (overrides: Partial<Session["user"]> = {}): Session =>
  ({
    user: {
      id: "u_1",
      email: "u@example.com",
      role: "candidate",
      verifiedRoles: ["candidate"],
      ...overrides,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

const buildRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/auth/verify-role", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];

describe("POST /api/v1/auth/verify-role (stub completion)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await POST(buildRequest({ role: "recruiter" }));
    expect(response.status).toBe(401);
    expect(markRoleAsVerifiedStubMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_role when the role field is missing", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({}));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_role");
    expect(markRoleAsVerifiedStubMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_role when the role field is a non-verifiable value", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({ role: "platform_ops" }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_role");
  });

  it("returns 400 invalid_payload when the body is not JSON", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(
      new Request("http://localhost/api/v1/auth/verify-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }) as unknown as Parameters<typeof POST>[0],
    );

    expect(response.status).toBe(400);
  });

  it("propagates 409 role_already_verified from the service layer", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedStubMock.mockRejectedValue(
      new RoleVerificationError(
        "role_already_verified",
        409,
        "Candidate role is already verified for this account",
      ),
    );

    const response = await POST(buildRequest({ role: "candidate" }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("role_already_verified");
  });

  it("happy path: flips recruiter on a candidate-only account and returns recruiter dashboard", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedStubMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(buildRequest({ role: "recruiter" }));
    const body = (await response.json()) as { verified: string; redirectTo: string };

    expect(response.status).toBe(200);
    expect(body.verified).toBe("recruiter");
    expect(body.redirectTo).toBe("/recruiter-dashboard");
    expect(markRoleAsVerifiedStubMock).toHaveBeenCalledWith("u_1", "recruiter");
  });
});
