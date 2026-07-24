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
import { attachDocumentToPendingSubmission } from "@/server/recruiter-verification/recruiter-verification-service";

// POST — attach an optional affiliation-proof document to the caller's open submission and
// receive a presigned PUT URL for the direct-to-R2 upload. Documents are a queue-priority signal
// and reviewer evidence only — never a grant condition. 404 when no open submission exists.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(["recruiter"]);
    assertSessionMatchesExpectedUser(request, session);

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
    const originalFileName = typeof raw.originalFileName === "string" ? raw.originalFileName : "";
    const contentType = typeof raw.contentType === "string" ? raw.contentType : "";
    const fileSizeBytes = Number(raw.fileSizeBytes ?? 0);

    if (
      !originalFileName ||
      !contentType ||
      !Number.isFinite(fileSizeBytes) ||
      fileSizeBytes <= 0
    ) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "originalFileName, contentType, and a positive fileSizeBytes are required",
          },
        },
        { status: 400 },
      );
    }

    const result = await attachDocumentToPendingSubmission(session.user.id, {
      originalFileName,
      contentType,
      fileSizeBytes,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
