import { NextResponse } from "next/server";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { cancelCompetitionAsOps, OpsPaymentError } from "@/server/finance/ops-payment-service";

type RouteParams = { params: Promise<{ competitionId: string }> };

// Cancel a competition on an organiser's behalf. platform_ops only, MFA-gated by requireSessionRole
// (DEC-0113 choke point). Body: { reason: string }.
//
// Refused, as the organiser's unpublish is (DEC-0132), while any transfer on the competition awaits
// verification or was verified. Outstanding proofs are NOT voided as a side effect. Each is its own
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
    if (error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
