import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  parseDeadlineExtensionInput,
  parseDocumentReviewInput,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import {
  cancelDocumentRequest,
  extendDocumentRequestDeadline,
  reviewDocumentRequest,
} from "@/server/registration-documents/registration-document-service";

// Acts on one existing request. The three actions share a route because they share a subject and a
// guard; `action` selects between them.
//
//   review  record the verdict (accept, reject, or reject-and-reopen)
//   extend  push the deadline out
//   cancel  withdraw an ask the organizer no longer needs
//
// Organizer tooling acting on another user's registration — Rule #16's cross-session guard is
// deliberately not applied.
export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ institutionSlug: string; competitionId: string; requestId: string }>;
  },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, requestId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;

    if (action === "review") {
      const review = parseDocumentReviewInput(body);
      const result = await reviewDocumentRequest(
        institutionId,
        session.user.id,
        requestId,
        review,
        db,
      );
      return NextResponse.json(result);
    }

    if (action === "extend") {
      const dueAt = parseDeadlineExtensionInput(body);
      const result = await extendDocumentRequestDeadline(
        institutionId,
        session.user.id,
        requestId,
        dueAt,
        db,
      );
      return NextResponse.json(result);
    }

    if (action === "cancel") {
      const result = await cancelDocumentRequest(institutionId, session.user.id, requestId, db);
      return NextResponse.json(result);
    }

    throw new RegistrationDocumentError(
      "document_request_invalid_payload",
      400,
      "action must be one of: review, extend, cancel",
    );
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
