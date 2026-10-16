// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { RecruiterVerificationError } from "@/server/recruiter-verification/recruiter-verification-core";

const { requireSessionRole, reviewRecruiterVerification } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  reviewRecruiterVerification: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/recruiter-verification/recruiter-verification-service", () => ({
  reviewRecruiterVerification,
}));

import { PATCH } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/recruiter-verification/submissions/sub1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ submissionId: "sub1" }) };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  reviewRecruiterVerification.mockResolvedValue({
    submissionId: "sub1",
    userId: "u1",
    status: "approved",
  });
});
afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/recruiter-verification/submissions/[submissionId]", () => {
  it("returns 200 and forwards the decision to the service", async () => {
    const res = await PATCH(patchReq({ decision: "approve" }), ctx);
    expect(res.status).toBe(200);
    expect(reviewRecruiterVerification).toHaveBeenCalledWith("ops1", "sub1", "approve", null, {
      allowResubmission: true,
    });
  });

  it("returns 403 and calls nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await PATCH(patchReq({ decision: "approve" }), ctx);
    expect(res.status).toBe(403);
    expect(reviewRecruiterVerification).not.toHaveBeenCalled();
  });

  it("returns 400 for a decision that is neither approve nor reject", async () => {
    const res = await PATCH(patchReq({ decision: "maybe" }), ctx);
    expect(res.status).toBe(400);
    expect(reviewRecruiterVerification).not.toHaveBeenCalled();
  });

  it("returns the service's domain error status", async () => {
    reviewRecruiterVerification.mockRejectedValueOnce(
      new RecruiterVerificationError("recruiter_verification_not_found", "missing"),
    );
    const res = await PATCH(patchReq({ decision: "approve" }), ctx);
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
    reviewRecruiterVerification.mockRejectedValueOnce(
      new OperatorActorError(code, 403, "actor refused"),
    );
    const response = await PATCH(patchReq({ decision: "approve" }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code, message: "actor refused" } });
  });
});
