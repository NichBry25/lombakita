import { NextResponse } from "next/server";
import { requireSessionRole } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  parseDocumentFileDeclaration,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import { prepareRequestDocumentUpload } from "@/server/registration-documents/registration-document-service";

// Presign step of the candidate's upload. Returns a presigned PUT and the server-chosen key, and
// writes no row — the row is created only once finalize has inspected the bytes that landed.
//
// Acts on the caller's OWN data, so Rule #16's cross-session guard runs immediately after the
// role gate. Ownership and existence collapse to one 404 in the service.
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);

    const { requestId } = await context.params;
    const payload = await request.json().catch(() => null);
    const file = parseDocumentFileDeclaration(payload);

    const prepared = await prepareRequestDocumentUpload(session.user.id, requestId, file);
    return NextResponse.json(prepared);
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
