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
import { prepareVerificationDocumentUpload } from "@/server/recruiter-verification/recruiter-verification-service";

// POST — presign step for an optional affiliation-proof document. Validates the declared file
// against the allowlist and returns a presigned PUT URL plus the server-chosen R2 key; the browser
// uploads to R2, then calls the finalize route to have the bytes inspected and the document row
// written. Documents are a queue-priority signal and reviewer evidence only — never a grant
// condition. 404 when no open submission exists.
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

    const result = await prepareVerificationDocumentUpload(session.user.id, {
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
