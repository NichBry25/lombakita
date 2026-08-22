import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  ManualProofError,
  rejectManualPaymentProof,
  verifyManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string; proofId: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// PATCH records the organiser's verdict on one bukti transfer. `action` selects between them:
//
//   verify  the money arrived. Writes the `succeeded` event and the fee accrual.
//   reject  it did not, or not correctly. Writes NO finance event, because a rejection
//           establishes nothing about the money either way, and carries `resubmissionAllowed`,
//           which is a real verdict rather than a UI state.
//
// The two share a route because they share a subject and a guard, matching how document-request
// review is shaped.
//
// The INSTITUTION is resolved from the slug and passed to the service, which puts the tenant scope
// inside the same WHERE as the CAS. A proof belonging to another organiser's competition matches no
// row and is refused as not-found rather than as forbidden.
//
// Organiser tooling acting on a CANDIDATE'S row. Rule 16's cross-session guard is deliberately not
// applied, matching every other organiser endpoint. That guard protects a user acting on their own
// data; this endpoint's authorization is the tenant boundary above.
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, proofId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const payload = await request.json().catch(() => null);
    const body = isRecord(payload) ? payload : {};
    const action = body.action;

    if (action === "verify") {
      const proof = await verifyManualPaymentProof(institutionId, session.user.id, proofId, db);
      return NextResponse.json({ proof });
    }

    if (action === "reject") {
      const reason = typeof body.reason === "string" ? body.reason : "";
      // Defaults to ALLOWED. Barring resubmission strands the payer until platform_ops intervenes,
      // so it is opt-in: a body that omits the field asks for the recoverable verdict.
      const resubmissionAllowed = body.resubmissionAllowed !== false;

      const proof = await rejectManualPaymentProof(
        institutionId,
        session.user.id,
        proofId,
        reason,
        resubmissionAllowed,
        db,
      );
      return NextResponse.json({ proof });
    }

    throw new ManualProofError(
      "manual_proof_action_unrecognised",
      "Tindakan tidak dikenali. Gunakan 'verify' atau 'reject'.",
      400,
    );
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
