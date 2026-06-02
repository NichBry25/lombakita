import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ModerationError, toModerationErrorResponse } from "@/server/moderation/moderation-core";
import { unsuspendUser } from "@/server/moderation/moderation-service";

type RouteParams = { params: Promise<{ userId: string }> };

// Reinstate a suspended user account. platform_ops only. Body: { reason: string }.
export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { userId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const rawReason = (body as { reason?: unknown })?.reason;
    const reason = typeof rawReason === "string" ? rawReason : "";

    const result = await unsuspendUser(session.user.id, userId, reason);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ModerationError) {
      return toModerationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
