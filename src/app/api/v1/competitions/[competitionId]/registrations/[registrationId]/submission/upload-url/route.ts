import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { SubmissionError, toSubmissionErrorResponse } from "@/server/submissions/submission-core";
import { generateSubmissionUploadUrl } from "@/server/submissions/submission-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// POST — request a short-lived presigned PUT URL for uploading a submission file to R2.
// Body: { fileName, fileMimeType? }. Returns { uploadUrl, fileKey, expiresAt }. When R2 is not
// configured the service raises submission_upload_unavailable → 503 (degraded, never a 500).
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId, registrationId } = await context.params;

    let payload: unknown = {};
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        payload = await request.json();
      } catch {
        throw new SubmissionError("submission_invalid_payload", "Request body must be valid JSON");
      }
    }

    const body = isRecord(payload) ? payload : {};
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const fileMimeType =
      typeof body.fileMimeType === "string" && body.fileMimeType.trim().length > 0
        ? body.fileMimeType.trim()
        : null;

    const grant = await generateSubmissionUploadUrl(
      competitionId,
      registrationId,
      session.user.id,
      {
        fileName,
        fileMimeType,
      },
    );
    return NextResponse.json(grant);
  } catch (error) {
    if (error instanceof SubmissionError) return toSubmissionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
