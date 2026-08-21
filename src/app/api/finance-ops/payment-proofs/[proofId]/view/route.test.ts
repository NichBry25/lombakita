// @vitest-environment node
//
// DEC-0162 AT THE ROUTE: finance_ops may LOOK at a bukti transfer and may do nothing else to it.
//
// The ruling was enforced in code and asserted only by the browser and API harnesses, both of which
// run locally and have never run in CI. So widening this gate — or pointing the finance shell at a
// verdict service — turned nothing red in the suite that actually gates merges. These assertions
// are the CI-enforced half.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, generateDisputeProofViewUrl, ManualProofError } = vi.hoisted(() => {
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
    generateDisputeProofViewUrl: vi.fn(),
    ManualProofError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/finance/dispute-view", () => ({ generateDisputeProofViewUrl }));
vi.mock("@/server/finance/manual-payment-proof-service", () => ({ ManualProofError }));

import { POST } from "./route";

const OPERATOR = { user: { id: "fin-1", role: "finance_ops" } };
const params = Promise.resolve({ proofId: "proof-1" });

const request = (): Request =>
  new Request("http://localhost/api/finance-ops/payment-proofs/proof-1/view", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionRole.mockResolvedValue(OPERATOR);
  generateDisputeProofViewUrl.mockResolvedValue({ url: "https://r2/x", contentType: "image/jpeg" });
});

describe("POST /api/finance-ops/payment-proofs/[proofId]/view", () => {
  it("admits finance_ops and NOBODY else — not even the other operator role", async () => {
    await POST(request(), { params });

    // Exact array. A widening to ["finance_ops", "platform_ops"] fails here, which is the whole
    // point: the two operator roles have separate audit trails and a shared gate would collapse
    // two access questions a dispute has to tell apart.
    expect(requireSessionRole).toHaveBeenCalledWith(["finance_ops"]);
  });

  it("mints nothing when the role gate rejects", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(request(), { params })).status).toBe(403);
    expect(generateDisputeProofViewUrl).not.toHaveBeenCalled();
  });

  it("surfaces the MFA challenge rather than minting a link", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("mfa_challenge_required", 403, "challenge required"),
    );

    expect((await POST(request(), { params })).status).toBe(403);
    expect(generateDisputeProofViewUrl).not.toHaveBeenCalled();
  });

  it("attributes the read to the calling operator, never to a caller-supplied id", async () => {
    await POST(request(), { params });

    expect(generateDisputeProofViewUrl).toHaveBeenCalledWith("fin-1", "proof-1");
  });
});

/**
 * THE ABSENCE THAT IS THE RULING. finance_ops has no verdict power, and the way that is enforced is
 * that the finance surface never reaches a verdict service at all.
 *
 * Asserted over source rather than over a render because the ruling is about REACHABILITY: a button
 * can be hidden by a condition, but a module that does not import `verifyManualPaymentProof` cannot
 * call it under any condition. Each file is also asserted to contain something, so a rename or a
 * deletion shows up as a failure here instead of as an empty scan that passes.
 */
describe("the finance surface cannot reach a verdict", () => {
  const FINANCE_MODULES = [
    "src/app/finance/payments/page.tsx",
    "src/app/finance/payments/[paymentId]/page.tsx",
    "src/app/api/finance-ops/payment-proofs/[proofId]/view/route.ts",
    "src/server/finance/dispute-view.ts",
  ];

  const VERDICT_WRITERS = [
    "verifyManualPaymentProof",
    "rejectManualPaymentProof",
    "reopenManualPaymentProof",
    "voidManualPaymentProof",
    "voidPaymentProofAsOps",
    "cancelCompetitionAsOps",
  ];

  it.each(FINANCE_MODULES)("%s names no verdict writer", (relative) => {
    const source = readFileSync(resolve(process.cwd(), relative), "utf8");

    // The file is really there and really has content — an unreadable path would throw, and an
    // empty one would satisfy every assertion below for the wrong reason.
    expect(source.length).toBeGreaterThan(200);

    for (const writer of VERDICT_WRITERS) {
      expect(source, `${relative} must not reach ${writer}`).not.toContain(writer);
    }
  });
});
