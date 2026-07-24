// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import { InstitutionTypeTransitionError } from "@/server/institution-workspace/institution-type";

const {
  requireSessionRole,
  assertSessionMatchesExpectedUser,
  upgradeInstitutionTypeForOwnerBySlug,
} = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  assertSessionMatchesExpectedUser: vi.fn(),
  upgradeInstitutionTypeForOwnerBySlug: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));

vi.mock("@/server/auth/access-core", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/access-core")>(
    "@/server/auth/access-core",
  );
  return { ...actual, assertSessionMatchesExpectedUser };
});

vi.mock("@/server/institution-workspace/institution-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/institution-workspace/institution-service")
  >("@/server/institution-workspace/institution-service");
  return { ...actual, upgradeInstitutionTypeForOwnerBySlug };
});

import { POST } from "@/app/api/v1/institutions/[institutionSlug]/upgrade/route";
import { InstitutionUpgradeError } from "@/server/institution-workspace/institution-service";

const sessionFixture = {
  user: { id: "user_1", role: "recruiter", email: "owner@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ institutionSlug: "nikau-bryan" }) };

const postRequest = (body: unknown) =>
  new Request("http://localhost/api/v1/institutions/nikau-bryan/upgrade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/institutions/[institutionSlug]/upgrade", () => {
  afterEach(() => vi.clearAllMocks());

  it("upgrades a personal institution and returns the re-derived slug", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    upgradeInstitutionTypeForOwnerBySlug.mockResolvedValue({
      institutionId: "inst_1",
      previousType: "personal",
      institutionType: "foundation",
      displayName: "Yayasan Harapan",
      slug: "yayasan-harapan",
      previousSlug: "nikau-bryan",
      resyncCompetitionIds: [],
    });

    const response = await POST(
      postRequest({ targetType: "foundation", displayName: "Yayasan Harapan" }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      institutionType: "foundation",
      displayName: "Yayasan Harapan",
      slug: "yayasan-harapan",
      previousSlug: "nikau-bryan",
    });
    expect(requireSessionRole).toHaveBeenCalledWith(["recruiter"]);
    // Rule #16 — the cross-session guard runs on this owner-scoped mutation.
    expect(assertSessionMatchesExpectedUser).toHaveBeenCalled();
  });

  it("rejects `personal` as an upgrade target at the boundary", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);

    const response = await POST(
      postRequest({ targetType: "personal", displayName: "Apa pun" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(upgradeInstitutionTypeForOwnerBySlug).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised target type", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);

    const response = await POST(postRequest({ targetType: "community" }), context);

    expect(response.status).toBe(400);
    expect(upgradeInstitutionTypeForOwnerBySlug).not.toHaveBeenCalled();
  });

  it("surfaces the tier gate as 403", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    upgradeInstitutionTypeForOwnerBySlug.mockRejectedValue(
      new InstitutionUpgradeError(
        "institution_upgrade_tier_insufficient",
        403,
        "Upgrading an institution requires the 'elevated' recruiter tier",
      ),
    );

    const response = await POST(
      postRequest({ targetType: "company", displayName: "PT Contoh" }),
      context,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "institution_upgrade_tier_insufficient" },
    });
  });

  it("surfaces the full-institution cap as 409", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    upgradeInstitutionTypeForOwnerBySlug.mockRejectedValue(
      new InstitutionUpgradeError("institution_upgrade_limit_reached", 409, "Limit reached"),
    );

    const response = await POST(
      postRequest({ targetType: "company", displayName: "PT Contoh" }),
      context,
    );

    expect(response.status).toBe(409);
  });

  it("surfaces an invalid official name with its validation status", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    upgradeInstitutionTypeForOwnerBySlug.mockRejectedValue(
      new InstitutionWorkspaceInputError(
        "institution_invalid_value",
        "displayName must be a string between 2 and 160 characters",
        { fields: ["displayName"] },
      ),
    );

    const response = await POST(postRequest({ targetType: "company", displayName: "x" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "institution_invalid_value" },
    });
  });

  it("surfaces a forbidden type transition as 409", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    upgradeInstitutionTypeForOwnerBySlug.mockRejectedValue(new InstitutionTypeTransitionError());

    const response = await POST(
      postRequest({ targetType: "company", displayName: "PT Contoh" }),
      context,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "institution_type_transition_forbidden" },
    });
  });

  it("returns 400 on a non-JSON body", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);

    const response = await POST(
      new Request("http://localhost/api/v1/institutions/nikau-bryan/upgrade", {
        method: "POST",
        body: "not json",
      }),
      context,
    );

    expect(response.status).toBe(400);
  });
});
