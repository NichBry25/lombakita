// @vitest-environment node
//
// Every assertion here that reads `not.toHaveBeenCalled()` is a MOVE test, not a redundancy.
//
// A removal test alone cannot tell a guard that runs from a guard that runs too late: delete the
// guard and the call succeeds, but MOVE it below the effect it protects and the call still throws —
// after the effect has already happened. Asserting that the protected call was never reached is the
// only thing at this layer that separates those two, which is what Rule 32 asks for in both
// directions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";

const {
  requireSessionRole,
  assertSessionMatchesExpectedUser,
  loadCandidatePaymentView,
  generateManualProofUploadUrl,
} = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  assertSessionMatchesExpectedUser: vi.fn(),
  loadCandidatePaymentView: vi.fn(),
  generateManualProofUploadUrl: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));

vi.mock("@/server/auth/access-core", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/auth/access-core")>("@/server/auth/access-core");
  return { ...actual, assertSessionMatchesExpectedUser };
});

vi.mock("@/server/finance/candidate-payment-view", () => ({ loadCandidatePaymentView }));

vi.mock("@/server/finance/manual-payment-proof-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/finance/manual-payment-proof-service")
  >("@/server/finance/manual-payment-proof-service");
  return { ...actual, generateManualProofUploadUrl };
});

import { POST } from "./route";

const CANDIDATE = {
  user: { id: "cand_1", role: "candidate", email: "c@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = {
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
};

const uploadRequest = (body: Record<string, unknown> = { fileName: "bukti.jpg" }): Request =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1/payment/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const payableView = (overrides: Record<string, unknown> = {}) => ({
  paymentId: "pay_1",
  competitionId: "comp_1",
  currency: "IDR",
  grossAmount: 150_000,
  dueAt: new Date("2026-09-01T00:00:00.000Z"),
  status: "pending",
  instructions: null,
  proof: null,
  isPayer: true,
  canSubmitProof: true,
  canResubmitProof: false,
  ...overrides,
});

const grant = {
  uploadUrl: "https://r2.example/put",
  r2Key: "payment-proofs/comp_1/pay_1/abc",
  contentType: "image/jpeg",
  expiresAt: new Date("2026-08-19T00:10:00.000Z"),
};

describe("POST …/payment/upload-url", () => {
  // resetAllMocks, not clearAllMocks: `clear` drops recorded calls but KEEPS implementations, so
  // the throwing guard installed by the mismatch test below would leak into every test after it
  // and turn five unrelated assertions into failures about a mismatch none of them set up.
  afterEach(() => vi.resetAllMocks());

  it("presigns for the payer of the caller's own payment group", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(payableView());
    generateManualProofUploadUrl.mockResolvedValue(grant);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(200);
    expect(requireSessionRole).toHaveBeenCalledWith(["candidate"]);
    expect(assertSessionMatchesExpectedUser).toHaveBeenCalled();
    // The PAYMENT is resolved from the registration and the SESSION, never taken from the body —
    // a caller-supplied payment id is the whole cross-payer attack this route would otherwise carry.
    expect(generateManualProofUploadUrl).toHaveBeenCalledWith("pay_1", "cand_1", {
      fileName: "bukti.jpg",
    });
  });

  it("refuses a caller the role gate rejects, and presigns nothing", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(uploadRequest(), context)).status).toBe(403);
    expect(loadCandidatePaymentView).not.toHaveBeenCalled();
    expect(generateManualProofUploadUrl).not.toHaveBeenCalled();
  });

  it("refuses on a cross-session mismatch BEFORE resolving any payment", async () => {
    // The downstream mocks are deliberately made to SUCCEED. If they were left unset the route
    // would fail on a null view first, and this test would report a 404 that proves nothing about
    // where the guard sits — the move probe would be detected by the wrong assertion.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(payableView());
    generateManualProofUploadUrl.mockResolvedValue(grant);
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "mismatch");
    });

    expect((await POST(uploadRequest(), context)).status).toBe(409);
    // Rule 16's guard is worth nothing below the work it protects: a presign issued and then
    // refused has already handed out a signed write URL. Moving the guard below the presign keeps
    // the 409 above and fails HERE, which is the whole reason this assertion exists.
    expect(generateManualProofUploadUrl).not.toHaveBeenCalled();
  });

  it("answers 404 for a registration that is not the caller's, and presigns nothing", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(null);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(404);
    expect(generateManualProofUploadUrl).not.toHaveBeenCalled();
  });

  it("refuses when the affordance is withheld, because a hidden control is not enforcement", async () => {
    // The UI does not render an upload control in this state. This asserts the endpoint refuses it
    // anyway — presentation decides what is offered, never what is permitted.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      payableView({ canSubmitProof: false, canResubmitProof: false }),
    );

    const response = await POST(uploadRequest(), context);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("manual_proof_resubmission_barred");
    expect(generateManualProofUploadUrl).not.toHaveBeenCalled();
  });

  it("presigns for a resubmission, which is the other half of the same gate", async () => {
    // Without this the withheld-affordance test above would also pass against a route that refused
    // every request, and the gate would be proving nothing.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      payableView({ canSubmitProof: false, canResubmitProof: true }),
    );
    generateManualProofUploadUrl.mockResolvedValue(grant);

    expect((await POST(uploadRequest(), context)).status).toBe(200);
    expect(generateManualProofUploadUrl).toHaveBeenCalled();
  });

  it("surfaces an unconfigured object store as 503, never as a 500", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(payableView());
    generateManualProofUploadUrl.mockRejectedValue(
      new ManualProofError("manual_proof_upload_unavailable", "Penyimpanan belum dikonfigurasi", 503),
    );

    expect((await POST(uploadRequest(), context)).status).toBe(503);
  });

  it("refuses in Indonesian", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(null);

    const body = (await (await POST(uploadRequest(), context)).json()) as {
      error: { message: string };
    };

    expect(body.error.message).toBe("Pembayaran tidak ditemukan");
  });
});
