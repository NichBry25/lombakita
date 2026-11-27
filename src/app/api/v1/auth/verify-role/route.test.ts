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
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

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

const buildRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/auth/verify-role", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];

// The four onboarding fields a candidate verification must carry (parity with signup paths).
const candidateProfileFields = {
  fullName: "Dinda Putri",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

// Fields an older host form still sends. The route reads none of them.
const olderHostFormFields = {
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
    // A recruiter-only account, so the request reaches profile parsing. The default session
    // already holds `candidate`, which is now refused earlier with 409 (see the test below).
    getServerSessionMock.mockResolvedValue(
      buildSession({ role: "recruiter", verifiedRoles: ["recruiter"] }),
    );

    const response = await POST(buildRequest({ role: "candidate" }));

    expect(response.status).toBe(400);
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("refuses an already-verified role with 409 before validating that role's payload", async () => {
    getServerSessionMock.mockResolvedValue(buildSession({ verifiedRoles: ["candidate"] }));

    // No onboarding profile: the payload is invalid, and would 400 if parsing ran first. The
    // caller's real problem is that the role is already held, so that is what it must be told.
    const response = await POST(buildRequest({ role: "candidate" }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("role_already_verified");
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("calls the host step with no form when a recruiter sends only its role", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
      hostTrusted: false,
    });

    const response = await POST(buildRequest({ role: "recruiter" }));
    const body = (await response.json()) as { verified: string; hostTrusted: boolean };

    expect(response.status).toBe(200);
    expect(body.verified).toBe("recruiter");
    expect(body.hostTrusted).toBe(false);
    expect(markRoleAsVerifiedMock).toHaveBeenCalledWith("u_1", "recruiter", null);
  });

  it("happy path: flips recruiter on a candidate-only account, ignores older host form fields and says the account is trusted", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
      hostTrusted: true,
    });

    const response = await POST(buildRequest({ role: "recruiter", ...olderHostFormFields }));
    const body = (await response.json()) as {
      verified: string;
      redirectTo: string;
      hostTrusted: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.verified).toBe("recruiter");
    expect(body.redirectTo).toBe("/recruiter-dashboard");
    expect(body.hostTrusted).toBe(true);
    expect(markRoleAsVerifiedMock).toHaveBeenCalledWith("u_1", "recruiter", null);
  });

  it("refuses a mismatched expected user before marking the role as verified", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(
      buildRequest(
        { role: "recruiter", ...olderHostFormFields },
        { [SESSION_USER_HEADER]: "someone_else" },
      ),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("refuses a mismatched expected user before marking the candidate role as verified", async () => {
    getServerSessionMock.mockResolvedValue(
      buildSession({ role: "recruiter", verifiedRoles: ["recruiter"] }),
    );
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(
      buildRequest(
        { role: "candidate", ...candidateProfileFields },
        { [SESSION_USER_HEADER]: "someone_else" },
      ),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });

  it("marks the role as verified when the expected user matches the session", async () => {
    getServerSessionMock.mockResolvedValue(buildSession());
    markRoleAsVerifiedMock.mockResolvedValue({
      candidateVerified: true,
      recruiterVerified: true,
    });

    const response = await POST(
      buildRequest({ role: "recruiter", ...olderHostFormFields }, { [SESSION_USER_HEADER]: "u_1" }),
    );

    expect(response.status).toBe(200);
    expect(markRoleAsVerifiedMock).toHaveBeenCalledOnce();
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
    expect(markRoleAsVerifiedMock).toHaveBeenCalledWith("u_1", "candidate", candidateProfileFields);
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

  it("refuses the candidate role to an operational account", async () => {
    for (const role of ["platform_ops", "finance_ops", "reviewer_or_judge"] as const) {
      getServerSessionMock.mockResolvedValue(buildSession({ role, verifiedRoles: [] }));

      const response = await POST(
        buildRequest(
          { role: "candidate", ...candidateProfileFields },
          { [SESSION_USER_HEADER]: "u_1" },
        ),
      );

      expect(response.status).toBe(403);
    }
    expect(markRoleAsVerifiedMock).not.toHaveBeenCalled();
  });
});
