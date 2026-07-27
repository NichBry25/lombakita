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
import { deleteVerificationDocumentForUser } from "@/server/recruiter-verification/recruiter-verification-service";

type RouteContext = { params: Promise<{ documentId: string }> };

// DELETE — removes an affiliation document the caller attached to their own open submission,
// dropping the row and the stored file. 404 when the document is unknown, belongs to another
// account, or hangs off a submission that has already been reviewed.
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

    const { documentId } = await context.params;
    await deleteVerificationDocumentForUser(session.user.id, documentId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
