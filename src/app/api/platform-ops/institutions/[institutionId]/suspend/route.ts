import { NextResponse } from "next/server";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ModerationError, toModerationErrorResponse } from "@/server/moderation/moderation-core";
import { suspendInstitution } from "@/server/moderation/moderation-service";

type RouteParams = { params: Promise<{ institutionId: string }> };

// Suspend an institution. platform_ops only. Body: { reason: string }.
export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { institutionId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawReason = (body as { reason?: unknown })?.reason;
    const reason = typeof rawReason === "string" ? rawReason : "";

    const result = await suspendInstitution(session.user.id, institutionId, reason);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ModerationError) {
      return toModerationErrorResponse(error);
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
