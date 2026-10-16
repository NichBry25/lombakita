// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { CompetitionReviewError } from "@/server/competitions/competition-reviews-core";

const { requireSessionRole, setReviewStatus } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  setReviewStatus: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/competitions/competition-reviews-service", () => ({ setReviewStatus }));

import { PATCH } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/competition-reviews/rev1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ reviewId: "rev1" }) };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  setReviewStatus.mockResolvedValue({ id: "rev1", status: "hidden" });
});
afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/competition-reviews/[reviewId]", () => {
  it("returns 200 and forwards (actor, reviewId, status, reason) to the service", async () => {
    const res = await PATCH(patchReq({ status: "hidden", reason: "spam" }), ctx);
    expect(res.status).toBe(200);
    expect(setReviewStatus).toHaveBeenCalledWith("ops1", "rev1", "hidden", "spam");
  });

  it("returns 403 and calls nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await PATCH(patchReq({ status: "hidden", reason: "spam" }), ctx);
    expect(res.status).toBe(403);
    expect(setReviewStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for a status that is neither visible nor hidden", async () => {
    const res = await PATCH(patchReq({ status: "gone", reason: "spam" }), ctx);
    expect(res.status).toBe(400);
    expect(setReviewStatus).not.toHaveBeenCalled();
  });

  it("returns the service's domain error status", async () => {
    setReviewStatus.mockRejectedValueOnce(
      new CompetitionReviewError("review_not_found", "Review not found", 404),
    );
    const res = await PATCH(patchReq({ status: "hidden", reason: "spam" }), ctx);
    expect(res.status).toBe(404);
  });
});

describe("database actor refusals", () => {
  it.each([
    "operator_actor_not_found",
    "operator_actor_not_platform_ops",
    "operator_actor_suspended",
    "operator_actor_is_target",
    "operator_actor_conflicted",
  ] as const)("returns 403 JSON for %s", async (code) => {
    setReviewStatus.mockRejectedValueOnce(new OperatorActorError(code, 403, "actor refused"));
    const response = await PATCH(patchReq({ status: "hidden", reason: "spam" }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code, message: "actor refused" } });
  });
});
