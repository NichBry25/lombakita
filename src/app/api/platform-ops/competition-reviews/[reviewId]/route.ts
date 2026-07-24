import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  CompetitionReviewError,
  toCompetitionReviewErrorResponse,
} from "@/server/competitions/competition-reviews-core";
import { setReviewStatus } from "@/server/competitions/competition-reviews-service";

// PATCH — platform-ops hide/restore a participant review. Body: { status: "visible" | "hidden",
// reason }. Records a platform_ops_audit_logs row in the same transaction.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { reviewId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }
    const raw = body as Record<string, unknown>;
    const status = raw.status;
    if (status !== "visible" && status !== "hidden") {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "status must be 'visible' or 'hidden'" } },
        { status: 400 },
      );
    }
    const reason = typeof raw.reason === "string" ? raw.reason : "";

    const review = await setReviewStatus(session.user.id, reviewId, status, reason);
    return NextResponse.json({ review });
  } catch (error) {
    if (error instanceof CompetitionReviewError) {
      return toCompetitionReviewErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
