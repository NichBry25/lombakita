import { NextResponse } from "next/server";
import { requireSessionRole } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import { deleteRequestDocumentFile } from "@/server/registration-documents/registration-document-service";

// Removes one of the candidate's own attached files — to swap a bad photo while the request is
// open, or to withdraw the document once the verdict is in and the file has served its purpose.
// Refused after a closing rejection, where the file is the evidence the refusal rests on.
//
// Acts on the caller's OWN data, so Rule #16's cross-session guard applies.
export async function DELETE(
  request: Request,
  context: { params: Promise<{ requestId: string; fileId: string }> },
) {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);

    const { fileId } = await context.params;
    await deleteRequestDocumentFile(session.user.id, fileId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
