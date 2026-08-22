import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";
import { generateDisputeProofViewUrl } from "@/server/finance/dispute-view";

type RouteParams = { params: Promise<{ proofId: string }> };

// Mints a short-lived link to a bukti transfer for dispute handling. finance_ops ONLY, MFA-gated by
// requireSessionRole (DEC-0113 choke point).
//
// A DISTINCT ROLE FROM THE ORGANISER'S EQUIVALENT, and a distinct audit trail: the organiser's view
// route admits recruiters scoped to their own institution and records the read against that
// institution, while this one admits finance_ops across every tenant and records it against the
// PAYER in the platform operator log. Widening either route to accept both roles would collapse
// two access questions that a dispute has to be able to tell apart.
//
// POST rather than GET because it WRITES: the audit row is the point, and a GET that mutates would
// be replayed by any prefetch.
export async function POST(_request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["finance_ops"]);
    const { proofId } = await params;

    const { url, contentType } = await generateDisputeProofViewUrl(session.user.id, proofId);
    return NextResponse.json({ url, contentType }, { status: 200 });
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
