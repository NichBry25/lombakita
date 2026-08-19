import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { loadCandidatePaymentView } from "@/server/finance/candidate-payment-view";
import {
  ManualProofError,
  generateManualProofUploadUrl,
} from "@/server/finance/manual-payment-proof-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// POST — presign a PUT for one bukti transfer file. Body: { fileName }.
// Returns { uploadUrl, r2Key, contentType, expiresAt }; the PUT must send that exact content type
// or R2 rejects the signature.
//
// The PAYMENT is resolved from the registration rather than accepted from the caller, and the
// object key is built by the service rather than supplied — a caller-chosen key would be refused at
// submission, but only after the presign had already granted write access to it.
//
// A declared MIME type is deliberately not accepted: the type is derived from the filename, and the
// signature binds whatever is declared, so a client-supplied type would be a client-chosen
// signature. When R2 is unconfigured this is 503 (degraded), never a 500.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { registrationId } = await context.params;

    let payload: unknown = {};
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        payload = await request.json();
      } catch {
        throw new ManualProofError(
          "manual_proof_object_key_invalid",
          "Isi permintaan harus berupa JSON yang valid",
          400,
        );
      }
    }

    const body = isRecord(payload) ? payload : {};
    const fileName = typeof body.fileName === "string" ? body.fileName : "";

    const view = await loadCandidatePaymentView(registrationId, session.user.id);

    // Not found rather than forbidden, and the same answer for "no such registration", "not your
    // payment group" and "this competition is free". A candidate probing ids learns nothing.
    if (!view) {
      throw new ManualProofError(
        "manual_proof_payment_not_found",
        "Pembayaran tidak ditemukan",
        404,
      );
    }

    // The affordance is WITHHELD in the UI, so reaching here means the request did not come from
    // the rendered page. Refused all the same: a withheld control is a presentation decision and
    // never the enforcement.
    if (!view.canSubmitProof && !view.canResubmitProof) {
      throw new ManualProofError(
        "manual_proof_resubmission_barred",
        "Bukti transfer tidak dapat dikirim untuk pembayaran ini saat ini",
        409,
      );
    }

    const grant = await generateManualProofUploadUrl(view.paymentId, session.user.id, { fileName });
    return NextResponse.json(grant);
  } catch (error) {
    if (error instanceof ManualProofError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
