import { NextResponse } from "next/server";
import { requireSessionRole } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  parseDocumentFileFinalizeInput,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import { finalizeRequestDocumentUpload } from "@/server/registration-documents/registration-document-service";

// Finalize step, called after the browser has PUT the file to storage. The service inspects the
// stored object's real size and magic bytes before writing a row; a file that fails is deleted and
// no row is created.
//
// Acts on the caller's OWN data, so Rule #16's cross-session guard applies.
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);

    const { requestId } = await context.params;
    const payload = await request.json().catch(() => null);
    const input = parseDocumentFileFinalizeInput(payload);

    const file = await finalizeRequestDocumentUpload(session.user.id, requestId, input);
    return NextResponse.json({
      file: {
        id: file.id,
        originalFileName: file.originalFileName,
        fileSizeBytes: file.fileSizeBytes,
        contentType: file.contentType,
        createdAt: file.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
