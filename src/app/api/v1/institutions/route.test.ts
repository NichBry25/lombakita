// @vitest-environment node

import { existsSync } from "node:fs";
import { join } from "node:path";
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

// The tier assertion is stubbed (it resolves by default) and the real error class and constants are kept.
vi.mock("@/server/auth/recruiter-tier", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/recruiter-tier")>(
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

const workspaceShellFixture = {
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

  it("refuses a host below the minimal tier and does not call the service", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    createInstitutionWorkspaceForUser.mockResolvedValue(workspaceShellFixture);
    assertRecruiterTier.mockRejectedValue(
      new RecruiterTierError(
        "recruiter_tier_insufficient",
        403,
        "Recruiter tier 'minimal' is required to perform this action",
        { requiredTier: "minimal", currentTier: "unverified" },
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

  it.each(["personal", "company", "foundation", "university", "campus_organization"])(
    "creates a workspace of kind %s for a host at the minimal tier",
    async (kind) => {
      requireSessionRole.mockResolvedValue(recruiterSessionFixture);
      assertRecruiterTier.mockResolvedValue(undefined);
      createInstitutionWorkspaceForUser.mockResolvedValue({
        ...workspaceShellFixture,
        institutionType: kind,
      });

      const request = new Request("http://localhost/api/v1/institutions", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Expected-User-Id": "user_1" },
        body: JSON.stringify({ displayName: "Ruang Uji", institutionType: kind }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(201);
      expect(createInstitutionWorkspaceForUser).toHaveBeenCalledWith("user_1", {
        displayName: "Ruang Uji",
        institutionType: kind,
      });
      expect(assertRecruiterTier).toHaveBeenCalledWith(recruiterSessionFixture, "minimal");
    },
  );

  it("refuses a mismatched expected user and does not call the service", async () => {
    requireSessionRole.mockResolvedValue(recruiterSessionFixture);
    assertRecruiterTier.mockResolvedValue(undefined);
    createInstitutionWorkspaceForUser.mockResolvedValue({
      ...workspaceShellFixture,
      institutionType: "personal",
    });

    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Expected-User-Id": "someone_else" },
      body: JSON.stringify({ displayName: "Ruang Uji", institutionType: "personal" }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("session_user_mismatch");
    expect(createInstitutionWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("has no personal or upgrade route beside it", () => {
    const personalRoute = join(process.cwd(), "src/app/api/v1/institutions/personal/route.ts");
    const upgradeRoute = join(
      process.cwd(),
      "src/app/api/v1/institutions/[institutionSlug]/upgrade/route.ts",
    );

    expect(existsSync(personalRoute)).toBe(false);
    expect(existsSync(upgradeRoute)).toBe(false);
  });
});
