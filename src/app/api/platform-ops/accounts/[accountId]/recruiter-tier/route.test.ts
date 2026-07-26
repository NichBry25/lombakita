// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const {
  requireSessionRole,
  elevateRecruiterTier,
  parseElevationInput,
  RecruiterTierElevationError,
} = vi.hoisted(() => {
  class RecruiterTierElevationError extends Error {
    constructor(
      public readonly code:
        | "tier_invalid_payload"
        | "tier_invalid_target"
        | "tier_account_not_found"
        | "tier_target_not_recruiter_verified",
      public readonly status: 400 | 404 | 422,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireSessionRole: vi.fn(),
    elevateRecruiterTier: vi.fn(),
    parseElevationInput: vi.fn(),
    RecruiterTierElevationError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/recruiter-tier/recruiter-tier-service", () => ({
  elevateRecruiterTier,
  parseElevationInput,
  RecruiterTierElevationError,
}));

import { PATCH } from "./route";

const platformOpsSession = {
  user: { id: "ops_1", role: "platform_ops", email: "ops@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (accountId: string) => ({
  params: Promise.resolve({ accountId }),
});

beforeEach(() => {
  parseElevationInput.mockImplementation((payload: unknown) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { tier?: string }).tier === "elevated"
    ) {
      return { tier: "elevated" };
    }
    throw new RecruiterTierElevationError(
      "tier_invalid_target",
      400,
      "Only tier='elevated' is accepted",
    );
  });
});

afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/accounts/[accountId]/recruiter-tier", () => {
  it("returns 200 with changed=true on successful elevation", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    elevateRecruiterTier.mockResolvedValue({ accountId: "u1", tier: "elevated", changed: true });

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ accountId: "u1", tier: "elevated", changed: true });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
    expect(elevateRecruiterTier).toHaveBeenCalledWith("ops_1", "u1");
  });

  it("returns 200 with changed=false when already elevated (idempotent)", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    elevateRecruiterTier.mockResolvedValue({ accountId: "u1", tier: "elevated", changed: false });

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.changed).toBe(false);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("forbidden", 403, "Insufficient role permissions"),
    );

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));

    expect(response.status).toBe(403);
    expect(elevateRecruiterTier).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));

    expect(response.status).toBe(401);
  });

  it("returns 400 when tier is not 'elevated'", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const response = await PATCH(makeRequest({ tier: "minimal" }), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("tier_invalid_target");
    expect(elevateRecruiterTier).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await PATCH(request, makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("tier_invalid_payload");
  });

  it("returns 422 when target account is not recruiter-verified", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    elevateRecruiterTier.mockRejectedValue(
      new RecruiterTierElevationError(
        "tier_target_not_recruiter_verified",
        422,
        "Account does not hold a verified recruiter role",
      ),
    );

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("tier_target_not_recruiter_verified");
  });

  it("returns 404 when target account is missing", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);
    elevateRecruiterTier.mockRejectedValue(
      new RecruiterTierElevationError("tier_account_not_found", 404, "Account not found"),
    );

    const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("ghost"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("tier_account_not_found");
  });
});
