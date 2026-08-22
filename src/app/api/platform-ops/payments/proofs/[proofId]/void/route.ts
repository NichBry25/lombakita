import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";
import { OpsPaymentError, voidPaymentProofAsOps } from "@/server/finance/ops-payment-service";

type RouteParams = { params: Promise<{ proofId: string }> };

// Void a bukti transfer that is awaiting review, the DEC-0132 escape hatch. platform_ops only,
// MFA-gated by requireSessionRole (DEC-0113 choke point). Body: { reason: string }.
//
// Writes NO finance event: nothing was confirmed received, so there is nothing to record about the
// money. The audit row is written inside the service transaction.
export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { proofId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawReason = (body as { reason?: unknown })?.reason;
    const reason = typeof rawReason === "string" ? rawReason : "";

    const proof = await voidPaymentProofAsOps(session.user.id, proofId, reason);
    return NextResponse.json({ proof }, { status: 200 });
  } catch (error) {
    if (error instanceof OpsPaymentError || error instanceof ManualProofError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
