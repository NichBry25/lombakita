import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { cancelCompetitionAsOps, OpsPaymentError } from "@/server/finance/ops-payment-service";

type RouteParams = { params: Promise<{ competitionId: string }> };

// Cancel a competition on an organiser's behalf, past the DEC-0132 in-flight unpublish block.
// platform_ops only, MFA-gated by requireSessionRole (DEC-0113 choke point).
// Body: { reason: string }.
//
// This is the escape hatch the organiser-facing block points at: an organiser with a genuine reason
// to cancel is not stuck, but the decision is made by someone who can see the outstanding transfers
// and is accountable for it. Outstanding proofs are NOT voided as a side effect — each is its own
// audited decision.
export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { competitionId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawReason = (body as { reason?: unknown })?.reason;
    const reason = typeof rawReason === "string" ? rawReason : "";

    const result = await cancelCompetitionAsOps(session.user.id, competitionId, reason);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof OpsPaymentError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
