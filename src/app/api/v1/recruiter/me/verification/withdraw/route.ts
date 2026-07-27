import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RecruiterVerificationError,
  toRecruiterVerificationErrorResponse,
} from "@/server/recruiter-verification/recruiter-verification-core";
import { withdrawRecruiterVerification } from "@/server/recruiter-verification/recruiter-verification-service";
import { toRecruiterVerificationView } from "@/app/api/v1/recruiter/me/verification/route";

// POST — take the caller's own submission out of the review queue and back into `draft` so its
// documents become editable again. A submission awaiting review is frozen precisely so a reviewer
// never decides on a document set that moves under them; this is the applicant's way to change it.
// 404 when nothing is awaiting review — including the case where a reviewer's verdict landed first.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    const submission = await withdrawRecruiterVerification(session.user.id);
    return NextResponse.json(toRecruiterVerificationView({ submission, documents: [] }).submission);
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
