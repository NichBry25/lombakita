// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { InstitutionInvitationError } from "@/server/institution-invitations/invitation-core";

const { requireAuthenticatedSession, createInstitutionInvitation, listPendingInvitations } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    createInstitutionInvitation: vi.fn(),
    listPendingInvitations: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-invitations/invitation-service", () => ({
  createInstitutionInvitation,
  listPendingInvitations,
}));

import { GET, POST } from "@/app/api/v1/institutions/[institutionSlug]/invitations/route";

const adminSession = {
  user: { id: "admin_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const invitationFixture = {
  id: "inv_1",
  invitedEmail: "staff@example.com",
  expiresAt: new Date("2026-05-08T00:00:00.000Z"),
};

describe("POST /api/v1/institutions/[institutionSlug]/invitations", () => {
  afterEach(() => vi.clearAllMocks());

  it("creates invitation and returns 201 for valid admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockResolvedValue(invitationFixture);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "staff@example.com",
        invitedRole: "institution_staff",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(createInstitutionInvitation).toHaveBeenCalledWith("admin_1", "universitas-nusantara", {
      invitedIdentifier: "staff@example.com",
      invitedRole: "institution_staff",
    });
    expect(body.invitation.invitedEmail).toBe("staff@example.com");
  });

  it("returns 403 for non-admin caller", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required for this institution"),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "staff@example.com",
        invitedRole: "institution_staff",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "other-institution" }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 409 for duplicate pending invite", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_already_pending",
        409,
        "An active invitation for this email already exists for this institution",
      ),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "staff@example.com",
        invitedRole: "institution_staff",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("invitation_already_pending");
  });

  it("returns 409 when invitee is already an active member", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_already_member",
        409,
        "This person is already a member of this institution",
      ),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "staff@example.com",
        invitedRole: "institution_staff",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("invitation_already_member");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "staff@example.com",
        invitedRole: "institution_staff",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });

    expect(response.status).toBe(401);
  });

  it("creates invitation with institution_owner role", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockResolvedValue(invitationFixture);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "owner@example.com",
        invitedRole: "institution_owner",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });

    expect(response.status).toBe(201);
    expect(createInstitutionInvitation).toHaveBeenCalledWith("admin_1", "universitas-nusantara", {
      invitedIdentifier: "owner@example.com",
      invitedRole: "institution_owner",
    });
  });

  it("creates invitation with institution_member role", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockResolvedValue(invitationFixture);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitedIdentifier: "member@example.com",
        invitedRole: "institution_member",
      }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });

    expect(response.status).toBe(201);
    expect(createInstitutionInvitation).toHaveBeenCalledWith("admin_1", "universitas-nusantara", {
      invitedIdentifier: "member@example.com",
      invitedRole: "institution_member",
    });
  });

  it("returns 400 for invalid identifier", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    createInstitutionInvitation.mockRejectedValue(
      new InstitutionInvitationError(
        "invitation_invalid_identifier",
        400,
        "invitedIdentifier must be a valid username or email address",
      ),
    );

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitedIdentifier: "!!", invitedRole: "institution_staff" }),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /api/v1/institutions/[institutionSlug]/invitations", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns pending invitations for admin", async () => {
    requireAuthenticatedSession.mockResolvedValue(adminSession);
    listPendingInvitations.mockResolvedValue([invitationFixture]);

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.invitations).toHaveLength(1);
  });
});
