// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import { RecruiterTierError } from "@/server/auth/recruiter-tier";

const { requireSessionRole, createInstitutionWorkspaceForUser, assertRecruiterTier } = vi.hoisted(
  () => ({
    requireSessionRole: vi.fn(),
    createInstitutionWorkspaceForUser: vi.fn(),
    assertRecruiterTier: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({
  requireSessionRole,
}));

vi.mock("@/server/institution-workspace/institution-service", () => ({
  createInstitutionWorkspaceForUser,
}));

// Step 6.5f.1 — full-institution creation now asserts the elevated recruiter tier. Stub the
// assertion (resolves by default) while keeping the real error class + threshold constant.
vi.mock("@/server/auth/recruiter-tier", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/auth/recruiter-tier")>(
      "@/server/auth/recruiter-tier",
    );
  return { ...actual, assertRecruiterTier };
});

import { POST } from "@/app/api/v1/institutions/route";

const recruiterSessionFixture = {
  user: {
    id: "user_1",
    role: "recruiter",
    email: "owner@example.com",
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

describe("POST /api/v1/institutions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates institution workspace for recruiter-verified account", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    assertRecruiterTier.mockResolvedValue(undefined);
    createInstitutionWorkspaceForUser.mockResolvedValue({
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
    });

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara",
      }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(createInstitutionWorkspaceForUser).toHaveBeenCalledWith("user_1", {
      displayName: "Universitas Nusantara",
    });
    expect(body.institution.slug).toBe("universitas-nusantara");
  });

  it("blocks candidate-only account from creating an institution (CCR-05)", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("forbidden", 403, "Insufficient role permissions"),
    );

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara",
      }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
    expect(createInstitutionWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("blocks unauthenticated institution creation", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Universitas Nusantara",
      }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");
  });

  it("maps institution input errors to 400 envelope", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    assertRecruiterTier.mockResolvedValue(undefined);
    createInstitutionWorkspaceForUser.mockRejectedValue(
      new InstitutionWorkspaceInputError(
        "institution_invalid_value",
        "displayName must be a string between 2 and 160 characters",
        { fields: ["displayName"] },
      ),
    );

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "",
      }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("institution_invalid_value");
    expect(body.error.details.fields).toContain("displayName");
  });

  // Step 6.5f.1 — full-institution creation requires the elevated recruiter tier.
  it("returns 403 when the recruiter tier is below elevated", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    assertRecruiterTier.mockRejectedValue(
      new RecruiterTierError(
        "recruiter_tier_insufficient",
        403,
        "Recruiter tier 'elevated' is required to perform this action",
        { requiredTier: "elevated", currentTier: "minimal" },
      ),
    );

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Kampus Penuh" }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("recruiter_tier_insufficient");
    expect(createInstitutionWorkspaceForUser).not.toHaveBeenCalled();
  });

  // F7 (Step 6.5b) — recruiter institution-creation limit surfaced at the route layer.
  it("returns 409 recruiter_institution_limit_reached when the recruiter is at the limit", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    assertRecruiterTier.mockResolvedValue(undefined);
    createInstitutionWorkspaceForUser.mockRejectedValue(
      new InstitutionWorkspaceInputError(
        "recruiter_institution_limit_reached",
        "Recruiter may own at most 3 institutions",
        undefined,
        409,
      ),
    );

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Kampus Keempat" }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("recruiter_institution_limit_reached");
  });
});
