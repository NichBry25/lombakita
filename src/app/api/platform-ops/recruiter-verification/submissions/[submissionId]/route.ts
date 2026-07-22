import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RecruiterVerificationError,
  toRecruiterVerificationErrorResponse,
} from "@/server/recruiter-verification/recruiter-verification-core";
import { reviewRecruiterVerification } from "@/server/recruiter-verification/recruiter-verification-service";

type RouteContext = { params: Promise<{ submissionId: string }> };

// PATCH — platform-ops review decision. Approving elevates the recruiter account to Trusted
// (tier `elevated`); rejecting requires a reason surfaced to the recruiter for re-submission.
// The status flip, tier elevation, and audit row all land in one transaction.
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { submissionId } = await context.params;

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
    const decision = raw.decision;
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "decision must be 'approve' or 'reject'" } },
        { status: 400 },
      );
    }

    const rejectionReason = typeof raw.rejectionReason === "string" ? raw.rejectionReason : null;

    const result = await reviewRecruiterVerification(
      session.user.id,
      submissionId,
      decision,
      rejectionReason,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
