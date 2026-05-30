import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { SubmissionError, toSubmissionErrorResponse } from "@/server/submissions/submission-core";
import { finalizeSubmission } from "@/server/submissions/submission-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

// POST — finalize (lock) the submission. Empty body. Returns the finalized record. 409
// submission_finalized when the submission is already finalized; 404 submission_not_found when
// there is no submission to finalize.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, registrationId } = await context.params;

    const submission = await finalizeSubmission(competitionId, registrationId, session.user.id);
    return NextResponse.json({ submission });
  } catch (error) {
    if (error instanceof SubmissionError) return toSubmissionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
