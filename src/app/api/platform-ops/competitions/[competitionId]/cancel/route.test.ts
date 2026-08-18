// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, cancelCompetitionAsOps, OpsPaymentError } = vi.hoisted(() => {
  class OpsPaymentError extends Error {
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
    cancelCompetitionAsOps: vi.fn(),
    OpsPaymentError,
  };
});

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/finance/ops-payment-service", () => ({
  cancelCompetitionAsOps,
  OpsPaymentError,
}));

import { POST } from "./route";

const OPERATOR = { user: { id: "ops-1", role: "platform_ops" } };
const params = Promise.resolve({ competitionId: "comp-1" });

const postBody = (body: unknown): Request =>
  new Request("http://localhost/api/platform-ops/competitions/comp-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionRole.mockResolvedValue(OPERATOR);
  cancelCompetitionAsOps.mockResolvedValue({
    competitionId: "comp-1",
    cancelledRegistrationCount: 3,
  });
});

describe("POST /api/platform-ops/competitions/[competitionId]/cancel", () => {
  it("gates on the platform_ops role, which is where the MFA challenge is applied", async () => {
    await POST(postBody({ reason: "organiser cannot run the event" }), { params });

    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("cancels on behalf of the organiser and attributes it to the calling operator", async () => {
    const response = await POST(postBody({ reason: "organiser cannot run the event" }), { params });

    expect(response.status).toBe(200);
    expect(cancelCompetitionAsOps).toHaveBeenCalledWith(
      "ops-1",
      "comp-1",
      "organiser cannot run the event",
    );
  });

  it("does not cancel anything when the role gate rejects", async () => {
    // This route cancels every registration on a competition and is irreversible, so the gate
    // failing must stop it before the service is reached at all.
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(postBody({ reason: "x" }), { params })).status).toBe(403);
    expect(cancelCompetitionAsOps).not.toHaveBeenCalled();
  });

  it("surfaces the MFA challenge rather than cancelling", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("mfa_challenge_required", 403, "challenge required"),
    );

    expect((await POST(postBody({ reason: "x" }), { params })).status).toBe(403);
    expect(cancelCompetitionAsOps).not.toHaveBeenCalled();
  });

  it("passes a missing reason through to the service as an empty string", async () => {
    // The reason is mandatory because the whole justification for this route existing is that a
    // human took responsibility for overriding a participant protection. The refusal lives in the
    // service so every caller gets it, not only this one.
    cancelCompetitionAsOps.mockRejectedValue(
      new OpsPaymentError("ops_reason_required", "reason required"),
    );

    const response = await POST(postBody({}), { params });
    const data = (await response.json()) as { error: { code: string } };

    expect(cancelCompetitionAsOps).toHaveBeenCalledWith("ops-1", "comp-1", "");
    expect(response.status).toBe(422);
    expect(data.error.code).toBe("ops_reason_required");
  });

  it("survives a body that is not JSON at all", async () => {
    cancelCompetitionAsOps.mockRejectedValue(
      new OpsPaymentError("ops_reason_required", "reason required"),
    );
    const request = new Request("http://localhost/api/platform-ops/competitions/comp-1/cancel", {
      method: "POST",
      body: "not json",
    });

    expect((await POST(request, { params })).status).toBe(422);
  });

  it("passes a not-published refusal through with its code and status", async () => {
    cancelCompetitionAsOps.mockRejectedValue(
      new OpsPaymentError("ops_competition_not_published", "already draft"),
    );

    const response = await POST(postBody({ reason: "x" }), { params });
    const data = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(422);
    expect(data.error.code).toBe("ops_competition_not_published");
  });

  it("passes a not-found through as 404", async () => {
    cancelCompetitionAsOps.mockRejectedValue(
      new OpsPaymentError("ops_competition_not_found", "no such competition", 404),
    );

    expect((await POST(postBody({ reason: "x" }), { params })).status).toBe(404);
  });

  it("ignores a reason that is not a string rather than passing it on", async () => {
    cancelCompetitionAsOps.mockRejectedValue(
      new OpsPaymentError("ops_reason_required", "reason required"),
    );

    await POST(postBody({ reason: { nested: "object" } }), { params });

    expect(cancelCompetitionAsOps).toHaveBeenCalledWith("ops-1", "comp-1", "");
  });
});
