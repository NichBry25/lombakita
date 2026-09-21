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

import { OperatorActorError } from "@/server/platform-ops/operator-actor";
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

  // THE BRANCH THE OTHER CASES CANNOT REACH. `OperatorActorError` comes from the platform-ops module
  // rather than from the service this file mocks, so every other rejection here is a
  // `RecruiterTierElevationError` or an `AccessError`. Without this case the actor branch could be
  // deleted outright and the suite would stay green — the error would fall through to
  // `toAccessDeniedResponse` and nothing would notice.
  //
  // Every code is asserted, because the branch echoes whichever one it was given and a hard-coded
  // code would satisfy a single case.
  it("returns the actor refusal's own code and status for each way the actor can fail", async () => {
    requireSessionRole.mockResolvedValue(platformOpsSession);

    const refusals = [
      { code: "operator_actor_not_found", message: "The acting account was not found" },
      {
        code: "operator_actor_not_platform_ops",
        message: "The acting account does not hold the platform_ops role",
      },
      {
        code: "operator_actor_suspended",
        message: "The acting account is suspended and cannot perform platform-ops actions",
      },
      {
        code: "operator_actor_is_target",
        message: "A platform-ops account cannot elevate its own recruiter tier",
      },
    ] as const;

    for (const refusal of refusals) {
      elevateRecruiterTier.mockRejectedValue(
        new OperatorActorError(refusal.code, 403, refusal.message),
      );

      const response = await PATCH(makeRequest({ tier: "elevated" }), makeParams("u1"));
      const body = await response.json();

      expect(response.status, `${refusal.code} did not answer 403`).toBe(403);
      expect(body.error.code, `${refusal.code} was not echoed`).toBe(refusal.code);
      expect(body.error.message).toBe(refusal.message);
    }
  });
});
