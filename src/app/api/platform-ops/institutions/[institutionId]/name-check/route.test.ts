// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSessionRole, decideNameCheck } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  decideNameCheck: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/institution-verification/name-check-service", () => ({ decideNameCheck }));

import { POST } from "./route";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { AccessError } from "@/server/auth/access-core";
import { VerificationError } from "@/server/institution-verification/verification-core";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/institutions/inst_1/name-check", {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ institutionId: "inst_1" }) };

const NAME_CHECK = {
  institutionId: "inst_1",
  decision: "name_ok",
  nameCheckedAt: "2026-11-01T00:00:00.000Z",
  nameProofDueAt: null,
};

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  decideNameCheck.mockResolvedValue(NAME_CHECK);
});
afterEach(() => vi.clearAllMocks());

describe("POST name-check", () => {
  it("returns 200 with the name check and forwards the decision", async () => {
    const response = await POST(postRequest({ decision: "name_ok", reason: "Nama sesuai." }), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nameCheck: NAME_CHECK });
    expect(decideNameCheck).toHaveBeenCalledWith("ops1", "inst_1", {
      decision: "name_ok",
      reason: "Nama sesuai.",
    });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("returns 400 and decides nothing for an unknown decision or a body that is not JSON", async () => {
    const byDecision = await POST(postRequest({ decision: "other" }), ctx);
    expect(byDecision.status).toBe(400);
    expect(await byDecision.json()).toEqual({
      error: { code: "invalid_payload", message: "decision must be 'name_ok' or 'require_proof'" },
    });

    const byBody = await POST(
      new Request("http://localhost/api/platform-ops/institutions/inst_1/name-check", {
        method: "POST",
        body: "{",
      }),
      ctx,
    );
    expect(byBody.status).toBe(400);
    expect(await byBody.json()).toEqual({
      error: { code: "invalid_payload", message: "Request body must be valid JSON" },
    });

    expect(decideNameCheck).not.toHaveBeenCalled();
  });

  it("returns the service's refusal with its status and code", async () => {
    decideNameCheck.mockRejectedValueOnce(
      new VerificationError("institution_name_proof_running", 409, "running"),
    );

    const response = await POST(postRequest({ decision: "require_proof", reason: "Bukti." }), ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "institution_name_proof_running", message: "running" },
    });
  });

  it("returns 403 JSON for a database actor refusal", async () => {
    decideNameCheck.mockRejectedValueOnce(
      new OperatorActorError("operator_actor_conflicted", 403, "actor refused"),
    );

    const response = await POST(postRequest({ decision: "name_ok" }), ctx);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "operator_actor_conflicted", message: "actor refused" },
    });
  });

  it("returns 403 and decides nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await POST(postRequest({ decision: "name_ok" }), ctx);

    expect(response.status).toBe(403);
    expect(decideNameCheck).not.toHaveBeenCalled();
  });
});
