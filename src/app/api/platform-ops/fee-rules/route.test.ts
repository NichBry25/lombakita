// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, createFeeRule, listFeeRules, FeeRuleError } = vi.hoisted(() => {
  class FeeRuleError extends Error {
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
    createFeeRule: vi.fn(),
    listFeeRules: vi.fn(),
    FeeRuleError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/finance/fee-rule-service", () => ({ createFeeRule, listFeeRules, FeeRuleError }));

import { GET, POST } from "./route";

const OPERATOR = { user: { id: "ops-1", role: "platform_ops" } };

const postBody = (body: Record<string, unknown>): Request =>
  new Request("http://localhost/api/platform-ops/fee-rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const validBody = {
  institutionId: null,
  currency: "IDR",
  basisPoints: 250,
  flatAmount: 0,
  minimumFeeAmount: null,
  maximumFeeAmount: null,
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveTo: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionRole.mockResolvedValue(OPERATOR);
});

describe("GET /api/platform-ops/fee-rules", () => {
  it("gates on the platform_ops role, which is where the MFA challenge is applied", async () => {
    listFeeRules.mockResolvedValue([]);

    await GET();

    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("refuses a caller the role gate rejects", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await GET()).status).toBe(403);
    expect(listFeeRules).not.toHaveBeenCalled();
  });

  it("surfaces the MFA challenge rather than listing rules", async () => {
    // The gate is shared, so this asserts the surface does not swallow the 403 into a generic error
    // and leave an unchallenged operator looking at platform pricing.
    requireSessionRole.mockRejectedValue(
      new AccessError("mfa_challenge_required", 403, "challenge required"),
    );

    const response = await GET();

    expect(response.status).toBe(403);
    expect(listFeeRules).not.toHaveBeenCalled();
  });
});

describe("POST /api/platform-ops/fee-rules", () => {
  it("records a rule and attributes it to the calling operator", async () => {
    createFeeRule.mockResolvedValue({ id: "rule-1" });

    const response = await POST(postBody(validBody));

    expect(response.status).toBe(201);
    expect(createFeeRule).toHaveBeenCalledWith(
      "ops-1",
      expect.objectContaining({ basisPoints: 250 }),
    );
  });

  it("does not write when the role gate rejects", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(postBody(validBody))).status).toBe(403);
    expect(createFeeRule).not.toHaveBeenCalled();
  });

  it("passes a full-gross clamp refusal through with its code", async () => {
    createFeeRule.mockRejectedValue(
      new FeeRuleError("fee_rule_takes_entire_payment", "takes everything"),
    );

    const response = await POST(postBody({ ...validBody, basisPoints: 10_000 }));
    const data = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(422);
    expect(data.error.code).toBe("fee_rule_takes_entire_payment");
  });

  it("refuses a negative or fractional rate before reaching the service", async () => {
    for (const basisPoints of [-1, 12.5]) {
      const response = await POST(postBody({ ...validBody, basisPoints }));

      expect(response.status).toBe(422);
    }

    expect(createFeeRule).not.toHaveBeenCalled();
  });

  it("refuses a missing or unparseable effective date", async () => {
    expect((await POST(postBody({ ...validBody, effectiveFrom: "" }))).status).toBe(422);
    expect((await POST(postBody({ ...validBody, effectiveFrom: "not a date" }))).status).toBe(422);
    expect(createFeeRule).not.toHaveBeenCalled();
  });

  it("treats a blank optional bound as absent rather than as zero", async () => {
    // "No maximum" and "a maximum of nothing" are different rules; coercing the first into the
    // second would cap every fee at zero and silently make the platform's rate irrelevant.
    createFeeRule.mockResolvedValue({ id: "rule-1" });

    await POST(postBody({ ...validBody, maximumFeeAmount: "", minimumFeeAmount: null }));

    expect(createFeeRule).toHaveBeenCalledWith(
      "ops-1",
      expect.objectContaining({ maximumFeeAmount: null, minimumFeeAmount: null }),
    );
  });

  it("normalises a lowercase currency rather than rejecting it", async () => {
    createFeeRule.mockResolvedValue({ id: "rule-1" });

    await POST(postBody({ ...validBody, currency: "idr" }));

    expect(createFeeRule).toHaveBeenCalledWith(
      "ops-1",
      expect.objectContaining({ currency: "IDR" }),
    );
  });
});
