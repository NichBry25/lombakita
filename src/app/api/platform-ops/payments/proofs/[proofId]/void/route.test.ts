// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, voidPaymentProofAsOps, OpsPaymentError, ManualProofError } = vi.hoisted(
  () => {
    class OpsPaymentError extends Error {
      constructor(
        public readonly code: string,
        message: string,
        public readonly status: number = 422,
      ) {
        super(message);
      }
    }
    class ManualProofError extends Error {
      constructor(
        public readonly code: string,
        message: string,
        public readonly status: number = 422,
      ) {
        super(message);
      }
    }
    return {
      requireSessionRole: vi.fn(),
      voidPaymentProofAsOps: vi.fn(),
      OpsPaymentError,
      ManualProofError,
    };
  },
);

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/finance/ops-payment-service", () => ({
  voidPaymentProofAsOps,
  OpsPaymentError,
}));
vi.mock("@/server/finance/manual-payment-proof-service", () => ({ ManualProofError }));

import { POST } from "./route";

const OPERATOR = { user: { id: "ops-1", role: "platform_ops" } };
const params = Promise.resolve({ proofId: "proof-1" });

const postBody = (body: unknown): Request =>
  new Request("http://localhost/api/platform-ops/payments/proofs/proof-1/void", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionRole.mockResolvedValue(OPERATOR);
  voidPaymentProofAsOps.mockResolvedValue({ id: "proof-1", status: "voided" });
});

describe("POST /api/platform-ops/payments/proofs/[proofId]/void", () => {
  it("gates on the platform_ops role, which is where the MFA challenge is applied", async () => {
    await POST(postBody({ reason: "refunded by bank" }), { params });

    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("voids the proof and attributes it to the calling operator", async () => {
    const response = await POST(postBody({ reason: "refunded by bank" }), { params });

    expect(response.status).toBe(200);
    expect(voidPaymentProofAsOps).toHaveBeenCalledWith("ops-1", "proof-1", "refunded by bank");
  });

  it("does not void anything when the role gate rejects", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(postBody({ reason: "x" }), { params })).status).toBe(403);
    expect(voidPaymentProofAsOps).not.toHaveBeenCalled();
  });

  it("surfaces the MFA challenge rather than voiding", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("mfa_challenge_required", 403, "challenge required"),
    );

    expect((await POST(postBody({ reason: "x" }), { params })).status).toBe(403);
    expect(voidPaymentProofAsOps).not.toHaveBeenCalled();
  });

  it("passes a missing reason through to the service as an empty string", async () => {
    voidPaymentProofAsOps.mockRejectedValue(
      new OpsPaymentError("ops_reason_required", "reason required"),
    );

    const response = await POST(postBody({}), { params });
    const data = (await response.json()) as { error: { code: string } };

    expect(voidPaymentProofAsOps).toHaveBeenCalledWith("ops-1", "proof-1", "");
    expect(response.status).toBe(422);
    expect(data.error.code).toBe("ops_reason_required");
  });

  it("survives a body that is not JSON at all", async () => {
    voidPaymentProofAsOps.mockRejectedValue(
      new OpsPaymentError("ops_reason_required", "reason required"),
    );
    const request = new Request("http://localhost/api/platform-ops/payments/proofs/proof-1/void", {
      method: "POST",
      body: "not json",
    });

    expect((await POST(request, { params })).status).toBe(422);
  });

  it("passes a proof-domain refusal through with its own code and status", async () => {
    // The service throws two error families and the route must not flatten one into a 500.
    voidPaymentProofAsOps.mockRejectedValue(
      new ManualProofError("manual_proof_not_voidable", "already verified", 409),
    );

    const response = await POST(postBody({ reason: "x" }), { params });
    const data = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(data.error.code).toBe("manual_proof_not_voidable");
  });
});
