import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  parseDocumentRequestInput,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import { createDocumentRequest } from "@/server/registration-documents/registration-document-service";

// Raises a document request against one named participant. The batch sibling at
// ../../document-requests reports a skip; here the organizer named one person, so an existing open
// request is a 409 they are entitled to see.
//
// Organizer tooling acting on another user's registration — Rule #16's cross-session guard is
// deliberately not applied.
export async function POST(
  request: Request,
  context: {
    params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
  },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const body = await request.json().catch(() => null);
    const input = parseDocumentRequestInput(body);

    const created = await createDocumentRequest(
      institutionId,
      competitionId,
      session.user.id,
      registrationId,
      input,
      db,
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
