// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

const { requireSessionRole, suspendUser, ModerationError } = vi.hoisted(() => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { requireSessionRole: vi.fn(), suspendUser: vi.fn(), ModerationError };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/moderation-service", () => ({ suspendUser }));
vi.mock("@/server/moderation/moderation-core", () => ({
  ModerationError,
  toModerationErrorResponse: (e: { code: string; message: string; status: number }) =>
    new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), {
      status: e.status,
      headers: { "content-type": "application/json" },
    }),
}));

import { POST } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const req = (body: unknown) =>
  new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  suspendUser.mockResolvedValue({
    userId: "u1",
    suspendedAt: "2026-06-02T00:00:00.000Z",
    suspensionReason: "abuse",
  });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/platform-ops/users/[userId]/suspend", () => {
  it("returns 200 on success", async () => {
    const res = await POST(req({ reason: "abuse" }), params("u1"));
    expect(res.status).toBe(200);
    expect(suspendUser).toHaveBeenCalledWith("ops1", "u1", "abuse");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("unauthenticated", 401, "no"));
    const res = await POST(req({ reason: "x" }), params("u1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await POST(req({ reason: "x" }), params("u1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 cannot_suspend_platform_ops from the service", async () => {
    suspendUser.mockRejectedValueOnce(
      new ModerationError("cannot_suspend_platform_ops", 403, "no"),
    );
    const res = await POST(req({ reason: "x" }), params("u1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("cannot_suspend_platform_ops");
  });

  it("returns 409 user_already_suspended from the service", async () => {
    suspendUser.mockRejectedValueOnce(new ModerationError("user_already_suspended", 409, "no"));
    const res = await POST(req({ reason: "x" }), params("u1"));
    expect(res.status).toBe(409);
  });
});

describe("database actor refusals", () => {
  it.each([
    "operator_actor_not_found",
    "operator_actor_not_platform_ops",
    "operator_actor_suspended",
  ] as const)("returns 403 JSON for %s", async (code) => {
    suspendUser.mockRejectedValueOnce(new OperatorActorError(code, 403, "actor refused"));
    const response = await POST(req({ reason: "reason" }), params("target"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code, message: "actor refused" } });
  });
});
