import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  parseSubmissionFileMetadata,
  SubmissionError,
  toSubmissionErrorResponse,
} from "@/server/submissions/submission-core";
import { createOrReplaceSubmission, getSubmission } from "@/server/submissions/submission-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

// GET — current submission for a registration the caller can access. Returns
// { submission: SubmissionRecord | null }. 404 when the access resolver returns null (missing
// registration, cross-competition IDOR, or caller not authorized).
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId, registrationId } = await context.params;
    const submission = await getSubmission(competitionId, registrationId, session.user.id);
    return NextResponse.json({ submission });
  } catch (error) {
    if (error instanceof SubmissionError) return toSubmissionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

// PUT — record (create) or replace submission metadata after the file is uploaded to R2.
// Body: { fileKey, fileName, fileSizeBytes? }. The stored content type is derived from the
// filename and confirmed against the object's magic bytes — a declared MIME is not accepted.
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, registrationId } = await context.params;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new SubmissionError("submission_invalid_payload", "Request body must be valid JSON");
    }

    const parsed = parseSubmissionFileMetadata(payload);
    if (parsed instanceof SubmissionError) {
      throw parsed;
    }

    const submission = await createOrReplaceSubmission(
      competitionId,
      registrationId,
      session.user.id,
      parsed,
    );
    return NextResponse.json({ submission });
  } catch (error) {
    if (error instanceof SubmissionError) return toSubmissionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
