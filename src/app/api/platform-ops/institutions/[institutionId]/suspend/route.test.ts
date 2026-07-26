// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, suspendInstitution, ModerationError } = vi.hoisted(() => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { requireSessionRole: vi.fn(), suspendInstitution: vi.fn(), ModerationError };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/moderation-service", () => ({ suspendInstitution }));
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
const params = (institutionId: string) => ({ params: Promise.resolve({ institutionId }) });

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  suspendInstitution.mockResolvedValue({
    institutionId: "i1",
    suspendedAt: "x",
    suspensionReason: "p",
  });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/platform-ops/institutions/[institutionId]/suspend", () => {
  it("returns 200 on success", async () => {
    const res = await POST(req({ reason: "policy" }), params("i1"));
    expect(res.status).toBe(200);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await POST(req({ reason: "x" }), params("i1"));
    expect(res.status).toBe(403);
  });

  it("returns 409 institution_already_suspended from the service", async () => {
    suspendInstitution.mockRejectedValueOnce(
      new ModerationError("institution_already_suspended", 409, "no"),
    );
    const res = await POST(req({ reason: "x" }), params("i1"));
    expect(res.status).toBe(409);
  });
});
