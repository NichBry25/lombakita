// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { InstitutionInvitationError } from "@/server/institution-invitations/invitation-core";

const { getCurrentSession, acceptInvitation } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  acceptInvitation: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ getCurrentSession }));
vi.mock("@/server/institution-invitations/invitation-service", () => ({ acceptInvitation }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "http://localhost:3000" } }));
vi.mock("@/config/env.server", () => ({
  serverEnv: { authUrl: undefined, appBaseUrl: undefined },
}));

import { POST } from "@/app/api/v1/auth/invitations/[token]/accept/route";

const authenticatedSession = {
  user: {
    id: "user_1",
    role: "candidate",
    email: "user@example.com",
    verifiedRoles: ["candidate"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const recruiterVerifiedSession = {
  user: {
    id: "user_2",
    role: "recruiter",
    email: "recruiter@example.com",
    verifiedRoles: ["recruiter"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const dualVerifiedSession = {
  user: {
    id: "user_3",
    role: "candidate",
    email: "dual@example.com",
    verifiedRoles: ["candidate", "recruiter"],
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const RAW_TOKEN = "a".repeat(64);

describe("POST /api/v1/auth/invitations/[token]/accept", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 before any token lookup when unauthenticated", async () => {
    getCurrentSession.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.callbackUrl).toContain(RAW_TOKEN);
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it("accepts invitation and returns 200 for authenticated user", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockResolvedValue(undefined);

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(acceptInvitation).toHaveBeenCalledWith(RAW_TOKEN, "user_1", ["candidate"]);
  });

  it("forwards recruiter verifiedRoles to acceptInvitation for a recruiter-verified session", async () => {
    getCurrentSession.mockResolvedValue(recruiterVerifiedSession);
    acceptInvitation.mockResolvedValue(undefined);

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(200);
    expect(acceptInvitation).toHaveBeenCalledWith(RAW_TOKEN, "user_2", ["recruiter"]);
  });

  it("forwards dual verifiedRoles to acceptInvitation for a candidate+recruiter session", async () => {
    getCurrentSession.mockResolvedValue(dualVerifiedSession);
    acceptInvitation.mockResolvedValue(undefined);

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(200);
    expect(acceptInvitation).toHaveBeenCalledWith(RAW_TOKEN, "user_3", [
      "candidate",
      "recruiter",
    ]);
  });

  it("forwards empty array when session.user.verifiedRoles is missing (legacy JWT)", async () => {
    const legacySession = {
      user: { id: "legacy_1", role: "candidate", email: "legacy@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    };
    getCurrentSession.mockResolvedValue(legacySession);
    acceptInvitation.mockResolvedValue(undefined);

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(200);
    expect(acceptInvitation).toHaveBeenCalledWith(RAW_TOKEN, "legacy_1", []);
  });

  it("returns 410 for expired token", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError("invitation_not_actionable", 410, "Invitation has expired"),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(410);
  });

  it("returns 410 for cancelled invitation", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation is cancelled and cannot be accepted",
      ),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(410);
  });

  it("returns 410 for already-accepted invitation", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_not_actionable",
        410,
        "Invitation is accepted and cannot be accepted",
      ),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(410);
  });

  it("returns 409 for duplicate membership", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_already_member",
        409,
        "You are already a member of this institution",
      ),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(409);
  });

  it("returns 404 for unknown token", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError("invitation_not_found", 404, "Invitation not found"),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 403 with redirectTo when account does not meet role verification requirement (CCR-07)", async () => {
    getCurrentSession.mockResolvedValue(authenticatedSession);
    acceptInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_role_verification_required",
        403,
        "Accepting this invitation requires a recruiter-verified account",
        "/verify/recruiter",
      ),
    );

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ token: RAW_TOKEN }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("invitation_role_verification_required");
    expect(body.error.redirectTo).toBe("/verify/recruiter");
  });
});
