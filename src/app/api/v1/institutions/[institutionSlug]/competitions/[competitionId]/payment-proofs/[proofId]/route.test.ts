// @vitest-environment node
//
// The organiser's verdict writes ACROSS A TENANT BOUNDARY onto a candidate's row, which is the shape
// that produced this lane's worst finding in 7.2-MANUAL.1. So the assertions that matter here are
// not about the happy path: they are that the institution resolved from the slug is the one handed
// to the service, and that nothing is written when that resolution fails.
//
// The tenant scope itself is enforced INSIDE the service, in the same WHERE as the CAS — a proof
// from another organiser's competition matches no row. What this file proves is the wiring: that the
// route passes the resolved institution rather than a caller-supplied one, and never calls the
// service at all when the boundary check throws.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";

const {
  requireAuthenticatedSession,
  requireAdminInstitutionBySlug,
  verifyManualPaymentProof,
  rejectManualPaymentProof,
  getDb,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  requireAdminInstitutionBySlug: vi.fn(),
  verifyManualPaymentProof: vi.fn(),
  rejectManualPaymentProof: vi.fn(),
  getDb: vi.fn(() => ({}) as never),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));

vi.mock("@/server/finance/manual-payment-proof-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/finance/manual-payment-proof-service")
  >("@/server/finance/manual-payment-proof-service");
  return { ...actual, verifyManualPaymentProof, rejectManualPaymentProof };
});

import { PATCH } from "./route";

const ORGANISER = {
  user: { id: "org_1", role: "recruiter", email: "o@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = {
  params: Promise.resolve({
    institutionSlug: "panitia-a",
    competitionId: "comp_1",
    proofId: "proof_1",
  }),
};

const verdictRequest = (body: Record<string, unknown>): Request =>
  new Request(
    "http://localhost/api/v1/institutions/panitia-a/competitions/comp_1/payment-proofs/proof_1",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

describe("PATCH …/payment-proofs/[proofId]", () => {
  afterEach(() => vi.resetAllMocks());

  it("verifies with the institution resolved from the slug, not one the caller named", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    verifyManualPaymentProof.mockResolvedValue({ id: "proof_1", status: "verified" });

    const response = await PATCH(
      // The body carries a DIFFERENT institution id. It must be ignored: accepting it would let any
      // organiser verify any tenant's proof by naming theirs.
      verdictRequest({ action: "verify", institutionId: "inst_b" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(requireAdminInstitutionBySlug).toHaveBeenCalledWith("org_1", "panitia-a", {});
    expect(verifyManualPaymentProof).toHaveBeenCalledWith("inst_a", "org_1", "proof_1", {});
  });

  it("rejects with a reason, and defaults the resubmission bar to ALLOWED", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    rejectManualPaymentProof.mockResolvedValue({ id: "proof_1", status: "rejected" });

    await PATCH(verdictRequest({ action: "reject", reason: "Nominal tidak cocok" }), context);

    // Barring resubmission strands the payer until platform_ops intervenes, so it is opt-in. An
    // omitted field asks for the recoverable verdict.
    expect(rejectManualPaymentProof).toHaveBeenCalledWith(
      "inst_a",
      "org_1",
      "proof_1",
      "Nominal tidak cocok",
      true,
      {},
    );
  });

  it("bars resubmission only when the organiser says so explicitly", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    rejectManualPaymentProof.mockResolvedValue({ id: "proof_1" });

    await PATCH(
      verdictRequest({ action: "reject", reason: "Bukan transfer ke kami", resubmissionAllowed: false }),
      context,
    );

    expect(rejectManualPaymentProof).toHaveBeenCalledWith(
      "inst_a",
      "org_1",
      "proof_1",
      "Bukan transfer ke kami",
      false,
      {},
    );
  });

  it("writes NOTHING when the caller does not administer the institution", async () => {
    // The cross-tenant negative. A recruiter at another institution reaches this route with a valid
    // session and a real proof id; the boundary is the slug resolution, and no verdict may be
    // written after it fails.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await PATCH(verdictRequest({ action: "verify" }), context)).status).toBe(403);
    expect(verifyManualPaymentProof).not.toHaveBeenCalled();
    expect(rejectManualPaymentProof).not.toHaveBeenCalled();
  });

  it("writes NOTHING for an unauthenticated caller", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, "nope"));

    expect((await PATCH(verdictRequest({ action: "verify" }), context)).status).toBe(401);
    expect(requireAdminInstitutionBySlug).not.toHaveBeenCalled();
    expect(verifyManualPaymentProof).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised action rather than guessing at one", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });

    const response = await PATCH(verdictRequest({ action: "approve" }), context);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    // Asserted by CODE, not only by status. The route previously answered this with
    // `manual_proof_not_pending` — a code that says the row has already been reviewed, which is a
    // claim about a proof nobody looked at. A status-only assertion could not see the difference.
    expect(body.error.code).toBe("manual_proof_action_unrecognised");
    expect(verifyManualPaymentProof).not.toHaveBeenCalled();
    expect(rejectManualPaymentProof).not.toHaveBeenCalled();
  });

  it("surfaces a reasonless rejection as the service's refusal, in Indonesian", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    rejectManualPaymentProof.mockRejectedValue(
      new ManualProofError(
        "manual_proof_reason_required",
        "Penolakan harus menyertakan alasan agar peserta tahu apa yang perlu diperbaiki",
        422,
      ),
    );

    const response = await PATCH(verdictRequest({ action: "reject", reason: "" }), context);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("manual_proof_reason_required");
    expect(body.error.message).toContain("harus menyertakan alasan");
  });

  it("surfaces a proof from another organiser's competition as the service's not-found", async () => {
    // The tenant scope lives in the service's WHERE, so a foreign proof id matches no row. The route
    // must pass that through unchanged rather than translating it into something that confirms the
    // proof exists somewhere.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    verifyManualPaymentProof.mockRejectedValue(
      new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404),
    );

    expect((await PATCH(verdictRequest({ action: "verify" }), context)).status).toBe(404);
  });
});
