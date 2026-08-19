// @vitest-environment node
//
// POST and PUT are two verbs over one resource because they enforce DIFFERENT RULES, and the tests
// that matter most here are the ones proving they never substitute for each other: a resubmission
// routed through the insert path would walk straight around the organiser's resubmission bar.
//
// Every `not.toHaveBeenCalled()` below is a MOVE test. A guard deleted and a guard placed after the
// write both throw; only "the write was never reached" separates them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";

const {
  requireSessionRole,
  assertSessionMatchesExpectedUser,
  loadCandidatePaymentView,
  submitManualPaymentProof,
  reopenManualPaymentProof,
} = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  assertSessionMatchesExpectedUser: vi.fn(),
  loadCandidatePaymentView: vi.fn(),
  submitManualPaymentProof: vi.fn(),
  reopenManualPaymentProof: vi.fn(),
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
  return { ...actual, submitManualPaymentProof, reopenManualPaymentProof };
});

import { POST, PUT } from "./route";

const CANDIDATE = {
  user: { id: "cand_1", role: "candidate", email: "c@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = {
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
};

const VALID_BODY = {
  r2Key: "payment-proofs/comp_1/pay_1/abc",
  originalFileName: "bukti.jpg",
  fileSizeBytes: 2048,
  contentType: "image/jpeg",
};

const proofRequest = (method: "POST" | "PUT", body: Record<string, unknown> = VALID_BODY): Request =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1/payment/proof", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const viewWith = (overrides: Record<string, unknown> = {}) => ({
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

const REJECTED_PROOF = {
  id: "proof_1",
  status: "rejected" as const,
  submittedAt: new Date("2026-08-15T00:00:00.000Z"),
  originalFileName: "bukti.jpg",
  rejectionReason: "Nominal tidak cocok",
  resubmissionAllowed: true,
  resubmissionCount: 0,
};

describe("POST …/payment/proof — the first bukti transfer", () => {
  afterEach(() => vi.resetAllMocks());

  it("records the proof against the caller's own payment and answers 201", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith());
    submitManualPaymentProof.mockResolvedValue({ id: "proof_1" });

    const response = await POST(proofRequest("POST"), context);

    expect(response.status).toBe(201);
    expect(requireSessionRole).toHaveBeenCalledWith(["candidate"]);
    expect(assertSessionMatchesExpectedUser).toHaveBeenCalled();
    // Payment and payer both come from the server's own resolution, never from the body.
    expect(submitManualPaymentProof).toHaveBeenCalledWith({
      paymentId: "pay_1",
      submittedByUserId: "cand_1",
      ...VALID_BODY,
    });
    // A first submission NEVER reaches the resubmission path, which is the only one that respects
    // the organiser's bar. If these two ever became one upsert, this is the assertion that breaks.
    expect(reopenManualPaymentProof).not.toHaveBeenCalled();
  });

  it("refuses on a cross-session mismatch BEFORE writing anything", async () => {
    // Downstream mocks made to SUCCEED on purpose: with them unset the route would refuse on a null
    // view first, and the assertion below would pass for a reason unrelated to the guard's position.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith());
    submitManualPaymentProof.mockResolvedValue({ id: "proof_1" });
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "mismatch");
    });

    expect((await POST(proofRequest("POST"), context)).status).toBe(409);
    expect(submitManualPaymentProof).not.toHaveBeenCalled();
  });

  it("answers 404 for a registration that is not the caller's, and writes nothing", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(null);

    expect((await POST(proofRequest("POST"), context)).status).toBe(404);
    expect(submitManualPaymentProof).not.toHaveBeenCalled();
  });

  it("refuses a declared size the presign never agreed to, and writes nothing", async () => {
    // Presign and record are two requests. Nothing stops a caller presigning a small receipt and
    // then declaring a 400MB one on the row.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith());

    const response = await POST(
      proofRequest("POST", { ...VALID_BODY, fileSizeBytes: 400 * 1024 * 1024 }),
      context,
    );

    expect(response.status).toBe(400);
    expect(submitManualPaymentProof).not.toHaveBeenCalled();
  });

  it("refuses a zero-byte file, which is an upload that did not happen", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith());

    expect(
      (await POST(proofRequest("POST", { ...VALID_BODY, fileSizeBytes: 0 }), context)).status,
    ).toBe(400);
    expect(submitManualPaymentProof).not.toHaveBeenCalled();
  });

  it("validates the body BEFORE resolving the payment", async () => {
    // Order matters for a reason that is not performance: `loadCandidatePaymentView` is the
    // ownership answer, and running it for a malformed request makes the endpoint a probe for
    // whether a registration id belongs to the caller.
    requireSessionRole.mockResolvedValue(CANDIDATE);

    await POST(proofRequest("POST", { ...VALID_BODY, originalFileName: "  " }), context);

    expect(loadCandidatePaymentView).not.toHaveBeenCalled();
  });

  it("surfaces a second submission as the resubmission refusal, in Indonesian", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith());
    submitManualPaymentProof.mockRejectedValue(
      new ManualProofError(
        "manual_proof_already_submitted",
        "Pembayaran ini sudah memiliki bukti transfer — kirim ulang melalui alur revisi",
        409,
      ),
    );

    const response = await POST(proofRequest("POST"), context);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("manual_proof_already_submitted");
    expect(body.error.message).toContain("kirim ulang melalui alur revisi");
  });
});

describe("PUT …/payment/proof — a replacement after a rejection or a void", () => {
  afterEach(() => vi.resetAllMocks());

  it("reopens the caller's own proof, resolving its id server-side", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      viewWith({ proof: REJECTED_PROOF, canSubmitProof: false, canResubmitProof: true }),
    );
    reopenManualPaymentProof.mockResolvedValue({ id: "proof_1" });

    const response = await PUT(proofRequest("PUT"), context);

    expect(response.status).toBe(200);
    // The proof id is NOT taken from the body. A candidate has exactly one proof per payment, so a
    // body parameter for it would exist only to name someone else's row.
    expect(reopenManualPaymentProof).toHaveBeenCalledWith({
      proofId: "proof_1",
      submittedByUserId: "cand_1",
      ...VALID_BODY,
    });
    // A resubmission NEVER reaches the insert path, which has no resubmission bar to respect.
    expect(submitManualPaymentProof).not.toHaveBeenCalled();
  });

  it("refuses on a cross-session mismatch BEFORE writing anything", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith({ proof: REJECTED_PROOF }));
    reopenManualPaymentProof.mockResolvedValue({ id: "proof_1" });
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "mismatch");
    });

    expect((await PUT(proofRequest("PUT"), context)).status).toBe(409);
    expect(reopenManualPaymentProof).not.toHaveBeenCalled();
  });

  it("answers 404 when there is no proof to replace", async () => {
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(viewWith({ proof: null }));

    expect((await PUT(proofRequest("PUT"), context)).status).toBe(404);
    expect(reopenManualPaymentProof).not.toHaveBeenCalled();
  });

  it("REOPENS A VOIDED PROOF THROUGH PUT even though the organiser barred resubmission", async () => {
    // Ruling R20, proven at the ROUTE and not only in the service. The voided arm is the reason
    // option B was chosen over stranding the payer, and a service that permits it is worth nothing
    // if the route in front of it refuses first — a `resubmissionAllowed: false` check added here
    // for tidiness would silently re-close the escape hatch and every service test would stay green.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      viewWith({
        proof: {
          ...REJECTED_PROOF,
          status: "voided",
          rejectionReason: null,
          // The bar the organiser set against their OWN rejection. A void is platform_ops
          // correcting something else, so it does not apply.
          resubmissionAllowed: false,
        },
        canSubmitProof: false,
        canResubmitProof: true,
      }),
    );
    reopenManualPaymentProof.mockResolvedValue({ id: "proof_1", status: "pending_review" });

    const response = await PUT(proofRequest("PUT"), context);

    expect(response.status).toBe(200);
    expect(reopenManualPaymentProof).toHaveBeenCalledWith({
      proofId: "proof_1",
      submittedByUserId: "cand_1",
      ...VALID_BODY,
    });
  });

  it("does not read the resubmission bar at the route at all", async () => {
    // The distinguishing input, in the sense probe 10 taught: a REJECTED proof with the bar set.
    // The route must still call the service and let the CAS decide. If a route-level bar were
    // added, the voided test above would keep passing (its view says canResubmitProof) while this
    // one would go red — which is the only pair that separates "the route defers" from "the route
    // happens to agree".
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      viewWith({
        proof: { ...REJECTED_PROOF, resubmissionAllowed: false },
        canResubmitProof: false,
      }),
    );
    reopenManualPaymentProof.mockRejectedValue(
      new ManualProofError(
        "manual_proof_resubmission_barred",
        "Bukti transfer ini tidak dapat dikirim ulang",
        409,
      ),
    );

    await PUT(proofRequest("PUT"), context);

    // Reached the service. The refusal came from the CAS, where a concurrent verdict cannot slip
    // past it, rather than from a read-then-write over the row the organiser is changing.
    expect(reopenManualPaymentProof).toHaveBeenCalled();
  });

  it("passes the organiser's bar through as a refusal rather than deciding it here", async () => {
    // The route does NOT read `canResubmitProof` to decide this. The bar lives in the CAS's WHERE,
    // where a concurrent verdict cannot slip past it; a route-level check would be a read-then-write
    // over exactly the row the organiser is changing.
    requireSessionRole.mockResolvedValue(CANDIDATE);
    loadCandidatePaymentView.mockResolvedValue(
      viewWith({ proof: { ...REJECTED_PROOF, resubmissionAllowed: false } }),
    );
    reopenManualPaymentProof.mockRejectedValue(
      new ManualProofError(
        "manual_proof_resubmission_barred",
        "Bukti transfer ini tidak dapat dikirim ulang",
        409,
      ),
    );

    const response = await PUT(proofRequest("PUT"), context);
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(409);
    expect(body.error.message).toBe("Bukti transfer ini tidak dapat dikirim ulang");
    expect(reopenManualPaymentProof).toHaveBeenCalled();
  });
});
