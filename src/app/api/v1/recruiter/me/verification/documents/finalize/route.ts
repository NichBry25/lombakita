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
import { finalizeVerificationDocumentUpload } from "@/server/recruiter-verification/recruiter-verification-service";

// POST — finalize step: run after the browser has uploaded to R2 via the presigned PUT URL. The
// server inspects the stored object's real size and magic-byte signature, and only then writes the
// document row. A file that fails content validation is deleted from storage and rejected (422).
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
    const r2Key = typeof raw.r2Key === "string" ? raw.r2Key : "";
    const originalFileName = typeof raw.originalFileName === "string" ? raw.originalFileName : "";

    if (!r2Key || !originalFileName) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "r2Key and originalFileName are required",
          },
        },
        { status: 400 },
      );
    }

    const document = await finalizeVerificationDocumentUpload(session.user.id, {
      r2Key,
      originalFileName,
    });

    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
