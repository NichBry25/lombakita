// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import { VerificationError } from "@/server/institution-verification/verification-core";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const {
  requireAuthenticatedSession,
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  getInstitutionWorkspaceForOwnerBySlug: vi.fn(),
  updateInstitutionWorkspaceForOwnerBySlug: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedSession,
}));

vi.mock("@/server/institution-workspace/institution-service", () => ({
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
}));

import { GET, PATCH } from "@/app/api/v1/institutions/[institutionSlug]/settings/route";

const sessionFixture = {
  user: {
    id: "user_1",
    role: "candidate",
    email: "owner@example.com",
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const institutionFixture = {
  institutionId: "inst_1",
  displayName: "Universitas Nusantara",
  slug: "universitas-nusantara",
  status: "inactive",
  ownerMembership: {
    membershipId: "m_1",
    membershipRole: "institution_owner",
    membershipStatus: "active",
    joinedAt: new Date("2026-04-16T00:00:00.000Z"),
  },
  createdAt: new Date("2026-04-16T00:00:00.000Z"),
  updatedAt: new Date("2026-04-16T00:00:00.000Z"),
};

describe("/api/v1/institutions/[institutionSlug]/settings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns owner-scoped institution settings by slug", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    getInstitutionWorkspaceForOwnerBySlug.mockResolvedValue(institutionFixture);

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getInstitutionWorkspaceForOwnerBySlug).toHaveBeenCalledWith(
      "user_1",
      "universitas-nusantara",
    );
    expect(body.institution.slug).toBe("universitas-nusantara");
  });

  it("blocks settings read for non-owner", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    getInstitutionWorkspaceForOwnerBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "Institution owner access required"),
    );

    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("updates owner-scoped institution settings", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockResolvedValue({
      ...institutionFixture,
      displayName: "Universitas Nusantara Indonesia",
      slug: "universitas-nusantara-indonesia",
    });

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara Indonesia",
        slug: "universitas-nusantara-indonesia",
      }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(updateInstitutionWorkspaceForOwnerBySlug).toHaveBeenCalledWith(
      "user_1",
      "universitas-nusantara",
      {
        displayName: "Universitas Nusantara Indonesia",
        slug: "universitas-nusantara-indonesia",
      },
    );
    expect(body.institution.slug).toBe("universitas-nusantara-indonesia");
  });

  it("refuses a mismatched expected user before updating the settings", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockResolvedValue({
      ...institutionFixture,
      displayName: "Universitas Nusantara Indonesia",
      slug: "universitas-nusantara-indonesia",
    });

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        [SESSION_USER_HEADER]: "someone_else",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara Indonesia",
        slug: "universitas-nusantara-indonesia",
      }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(updateInstitutionWorkspaceForOwnerBySlug).not.toHaveBeenCalled();
  });

  it("updates the settings when the expected user matches the session", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockResolvedValue({
      ...institutionFixture,
      displayName: "Universitas Nusantara Indonesia",
      slug: "universitas-nusantara-indonesia",
    });

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        [SESSION_USER_HEADER]: "user_1",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara Indonesia",
        slug: "universitas-nusantara-indonesia",
      }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });

    expect(response.status).toBe(200);
    expect(updateInstitutionWorkspaceForOwnerBySlug).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid settings payload", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockRejectedValue(
      new InstitutionWorkspaceInputError(
        "institution_invalid_value",
        "slug must be a string with 3 to 64 URL-safe characters",
        {
          fields: ["slug"],
        },
      ),
    );

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "??",
      }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ institutionSlug: "universitas-nusantara" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("institution_invalid_value");
  });

  it("answers an unconfirmed tick removal with 409", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockRejectedValue(
      new VerificationError(
        "institution_tick_removal_unconfirmed",
        409,
        "This change removes the workspace tick. Send acknowledgeTickRemoval true to confirm it",
      ),
    );

    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "content-type": "application/json", [SESSION_USER_HEADER]: "user_1" },
        body: JSON.stringify({ displayName: "Nama Baru" }),
      }) as never,
      { params: Promise.resolve({ institutionSlug: "universitas-nusantara" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("institution_tick_removal_unconfirmed");
  });

  it("answers a tick write conflict with 409", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateInstitutionWorkspaceForOwnerBySlug.mockRejectedValue(
      new VerificationError(
        "verification_transition_conflict",
        409,
        "This institution's verification status changed while you were deciding. Reload and try again",
      ),
    );

    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "content-type": "application/json", [SESSION_USER_HEADER]: "user_1" },
        body: JSON.stringify({ displayName: "Nama Baru", acknowledgeTickRemoval: true }),
      }) as never,
      { params: Promise.resolve({ institutionSlug: "universitas-nusantara" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("verification_transition_conflict");
  });
});
