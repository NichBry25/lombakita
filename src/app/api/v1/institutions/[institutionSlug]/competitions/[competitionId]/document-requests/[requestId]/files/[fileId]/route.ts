import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import { resolveRequestFileUrlForInstitution } from "@/server/registration-documents/registration-document-service";

// Mints a short-lived presigned GET for one attached document.
//
// `inline` renders it in a browser tab; `attachment` downloads it. The response content type is
// bound to the type detected at upload so the browser never sniffs.
//
// This access is audited in the service. It is the one read in the app that writes an audit row,
// because it hands an organizer a student's identity document.
export async function GET(
  request: Request,
  context: {
    params: Promise<{
      institutionSlug: string;
      competitionId: string;
      requestId: string;
      fileId: string;
    }>;
  },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, requestId, fileId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const requested = new URL(request.url).searchParams.get("disposition");
    const disposition = requested === "attachment" ? "attachment" : "inline";

    const result = await resolveRequestFileUrlForInstitution(
      institutionId,
      session.user.id,
      requestId,
      fileId,
      disposition,
      db,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
