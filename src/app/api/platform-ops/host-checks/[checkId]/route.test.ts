// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSessionRole, decideHostCheck, HostCheckDecisionError } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  decideHostCheck: vi.fn(),
  HostCheckDecisionError: class extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/host-trust/host-check-decision-service", () => ({
  decideHostCheck,
  HostCheckDecisionError,
}));

import { POST } from "./route";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { AccessError } from "@/server/auth/access-core";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/host-checks/check_1", {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ checkId: "check_1" }) };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  decideHostCheck.mockResolvedValue({
    id: "check_1",
    userId: "u1",
    status: "approved",
    published: true,
  });
});
afterEach(() => vi.clearAllMocks());

describe("POST host-checks/[checkId]", () => {
  it("returns 200 with the decision and forwards an approval", async () => {
    const response = await POST(postRequest({ decision: "approve" }), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hostCheck: { id: "check_1", userId: "u1", status: "approved", published: true },
    });
    expect(decideHostCheck).toHaveBeenCalledWith("ops1", "check_1", { decision: "approve" });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("forwards a turn-down with its guideline item and note", async () => {
    await POST(
      postRequest({
        decision: "turn_down",
        guidelineItem: "kontak-nyata",
        note: "Nomor kontak tidak aktif.",
      }),
      ctx,
    );

    expect(decideHostCheck).toHaveBeenCalledWith("ops1", "check_1", {
      decision: "turn_down",
      guidelineItem: "kontak-nyata",
      note: "Nomor kontak tidak aktif.",
    });
  });

  it("passes a turn-down without an item or a note on as empty strings", async () => {
    await POST(postRequest({ decision: "turn_down" }), ctx);

    expect(decideHostCheck).toHaveBeenCalledWith("ops1", "check_1", {
      decision: "turn_down",
      guidelineItem: "",
      note: "",
    });
  });

  it("returns 403 and decides nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await POST(postRequest({ decision: "approve" }), ctx);

    expect(response.status).toBe(403);
    expect(decideHostCheck).not.toHaveBeenCalled();
  });

  it("returns 400 and decides nothing for an unknown decision or a body that is not JSON", async () => {
    const byDecision = await POST(postRequest({ decision: "maybe" }), ctx);
    expect(byDecision.status).toBe(400);

    const byBody = await POST(
      new Request("http://localhost/api/platform-ops/host-checks/check_1", {
        method: "POST",
        body: "{",
      }),
      ctx,
    );
    expect(byBody.status).toBe(400);

    expect(decideHostCheck).not.toHaveBeenCalled();
  });

  it("returns the service's refusal with its status and code", async () => {
    decideHostCheck.mockRejectedValueOnce(
      new HostCheckDecisionError("host_check_already_decided", 409, "closed"),
    );

    const response = await POST(postRequest({ decision: "approve" }), ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "host_check_already_decided", message: "closed" },
    });
  });

  it("returns 403 JSON for a database actor refusal", async () => {
    decideHostCheck.mockRejectedValueOnce(
      new OperatorActorError("operator_actor_is_target", 403, "actor refused"),
    );

    const response = await POST(postRequest({ decision: "approve" }), ctx);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "operator_actor_is_target", message: "actor refused" },
    });
  });
});
