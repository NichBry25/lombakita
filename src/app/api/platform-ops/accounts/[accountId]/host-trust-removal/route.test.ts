// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireSessionRole, removeHostTrust, HostTrustRemovalError } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  removeHostTrust: vi.fn(),
  HostTrustRemovalError: class extends Error {
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
vi.mock("@/server/host-trust/host-trust-service", () => ({
  removeHostTrust,
  HostTrustRemovalError,
}));

import { POST } from "./route";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { AccessError } from "@/server/auth/access-core";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const postRequest = (body: unknown) =>
  new Request("http://localhost/api/platform-ops/accounts/u1/host-trust-removal", {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ accountId: "u1" }) };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  removeHostTrust.mockResolvedValue({ accountId: "u1", tier: "minimal" });
});
afterEach(() => vi.clearAllMocks());

describe("POST host-trust-removal", () => {
  it("returns 200 with the removal and forwards the reason", async () => {
    const response = await POST(postRequest({ reason: "Kontak palsu." }), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: "u1", tier: "minimal" });
    expect(removeHostTrust).toHaveBeenCalledWith("ops1", "u1", "Kontak palsu.");
  });

  it("passes a body without a string reason on as an empty reason", async () => {
    await POST(postRequest({}), ctx);
    await POST(postRequest({ reason: 5 }), ctx);

    expect(removeHostTrust).toHaveBeenNthCalledWith(1, "ops1", "u1", "");
    expect(removeHostTrust).toHaveBeenNthCalledWith(2, "ops1", "u1", "");
  });

  it("returns 403 and removes nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await POST(postRequest({ reason: "Kontak palsu." }), ctx);

    expect(response.status).toBe(403);
    expect(removeHostTrust).not.toHaveBeenCalled();
  });

  it("returns 400 and removes nothing for a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/platform-ops/accounts/u1/host-trust-removal", {
        method: "POST",
        body: "{",
      }),
      ctx,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_payload", message: "Request body must be valid JSON" },
    });
    expect(removeHostTrust).not.toHaveBeenCalled();
  });

  it("returns the service's refusal with its status and code", async () => {
    removeHostTrust.mockRejectedValueOnce(
      new HostTrustRemovalError("host_trust_not_trusted", 409, "not trusted"),
    );

    const response = await POST(postRequest({ reason: "Kontak palsu." }), ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "host_trust_not_trusted", message: "not trusted" },
    });
  });

  it("returns 403 JSON for a database actor refusal", async () => {
    removeHostTrust.mockRejectedValueOnce(
      new OperatorActorError("operator_actor_is_target", 403, "actor refused"),
    );

    const response = await POST(postRequest({ reason: "Kontak palsu." }), ctx);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "operator_actor_is_target", message: "actor refused" },
    });
  });
});
