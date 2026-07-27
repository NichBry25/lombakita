import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RecruiterVerificationError,
  toRecruiterVerificationErrorResponse,
} from "@/server/recruiter-verification/recruiter-verification-core";
import { setRecruiterResubmissionAllowed } from "@/server/recruiter-verification/recruiter-verification-service";

type RouteContext = { params: Promise<{ submissionId: string }> };

// PATCH — reverse the resubmission bar a reviewer set when rejecting. A distinct sub-resource
// because the parent path's PATCH is the review decision itself. Rejected submissions only:
// 409 on a pending or approved one. platform_ops only; the flip and its audit row share a
// transaction.
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

    const allowed = (body as Record<string, unknown>).allowed;
    if (typeof allowed !== "boolean") {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "allowed must be a boolean" } },
        { status: 400 },
      );
    }

    await setRecruiterResubmissionAllowed(session.user.id, submissionId, allowed);
    return NextResponse.json({ submissionId, allowed });
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
