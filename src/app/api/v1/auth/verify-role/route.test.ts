// @vitest-environment node

import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getServerSessionMock, markRoleAsVerifiedMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn<() => Promise<Session | null>>(),
  markRoleAsVerifiedMock: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/server/auth/auth.config", () => ({
  authOptions: {},
}));

vi.mock("@/server/auth/role-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/role-verification")>();
  return {
    ...actual,
    markRoleAsVerified: markRoleAsVerifiedMock,
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

// The four onboarding fields a candidate verification must carry (parity with signup paths).
const candidateProfileFields = {
  fullName: "Dinda Putri",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

// The recruiter affiliation form a recruiter verification must carry.
const recruiterVerificationFields = {
  fullName: "Rendra Wijaya",
  mobileNumber: "0812345678",
  corporateEmail: "rendra@corp.co.id",
};

describe("POST /api/v1/auth/verify-role", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await POST(buildRequest({ role: "recruiter" }));
    expect(response.status).toBe(401);
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_role when the role field is missing", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({}));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_role");
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
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
    markRoleAsVerifiedMock.mockRejectedValue(
      new RoleVerificationError(
        "role_already_verified",
        409,
        "Candidate role is already verified for this account",
      ),
    );

    const response = await POST(buildRequest({ role: "candidate", ...candidateProfileFields }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("role_already_verified");
  });

  it("returns 400 and does not call the service when a candidate omits its onboarding profile", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({ role: "candidate" }));

    expect(response.status).toBe(400);
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("returns 400 and does not call the service when a recruiter omits the affiliation form", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());

    const response = await POST(buildRequest({ role: "recruiter" }));

    expect(response.status).toBe(400);
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("happy path: flips recruiter on a candidate-only account and returns recruiter dashboard", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(
      buildRequest({ role: "recruiter", ...recruiterVerificationFields }),
    );
    const body = (await response.json()) as { verified: string; redirectTo: string };

    expect(response.status).toBe(200);
    expect(body.verified).toBe("recruiter");
    expect(body.redirectTo).toBe("/recruiter-dashboard");
    // Recruiter verification passes null for the candidate profile and the parsed form.
    expect(markRoleAsVerifiedMock).toHaveBeenCalledWith("u_1", "recruiter", null, {
      fullName: "Rendra Wijaya",
      mobileNumber: "0812345678",
      corporateEmail: "rendra@corp.co.id",
    });
  });

  it("happy path: verifies candidate on a recruiter-only account and passes the onboarding profile", async () => {
    getServerSessionMock.mockResolvedValue(
      buildSession({ role: "recruiter", verifiedRoles: ["recruiter"] }),
    );
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(buildRequest({ role: "candidate", ...candidateProfileFields }));
    const body = (await response.json()) as { verified: string; redirectTo: string };

    expect(response.status).toBe(200);
    expect(body.verified).toBe("candidate");
    expect(body.redirectTo).toBe("/candidate-dashboard");
    expect(markRoleAsVerifiedMock).toHaveBeenCalledWith(
      "u_1",
      "candidate",
      candidateProfileFields,
      null,
    );
  });

  // An operational account is created as a candidate or recruiter before being promoted, so it
  // carries a participant verification timestamp it must never be able to build on. Granting
  // itself the other participant role here would file its own trust submission, which the same
  // account can then approve from the platform-ops queue.
  it.each(["platform_ops", "finance_ops"] as const)(
    "refuses a %s session and writes nothing",
    async (role) => {
      getServerSessionMock.mockResolvedValue(buildSession({ role, verifiedRoles: ["candidate"] }));

      const response = await POST(
        buildRequest({
          role: "recruiter",
          fullName: "Rendra Wijaya",
          mobileNumber: "0812345678",
        }),
      );

      expect(response.status).toBe(403);
      expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
    },
  );
});
