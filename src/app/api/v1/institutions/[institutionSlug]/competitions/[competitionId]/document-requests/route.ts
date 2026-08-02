import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  RegistrationDocumentError,
  parseBatchDocumentRequestInput,
  toRegistrationDocumentErrorResponse,
} from "@/server/registration-documents/registration-document-core";
import {
  createDocumentRequestsForRegistrations,
  listDocumentRequestsForCompetition,
} from "@/server/registration-documents/registration-document-service";

// Organizer tooling acting on other users' registrations. The institution_member exclusion is
// enforced by requireAdminInstitutionBySlug, and per Rule #16 the cross-session guard is
// deliberately NOT applied — this does not act on the caller's own data.

// Every document request raised on this competition, for the organizer console.
export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const requests = await listDocumentRequestsForCompetition(institutionId, competitionId, {}, db);
    return NextResponse.json({ requests });
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}

// Raises one request against each named participant. Returns 200 with both outcomes rather than an
// error when some targets are skipped: one participant who already holds an open request must not
// cost the rest of the batch theirs.
export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const body = await request.json().catch(() => null);
    const { registrationIds, ...input } = parseBatchDocumentRequestInput(body);

    const outcome = await createDocumentRequestsForRegistrations(
      institutionId,
      competitionId,
      session.user.id,
      registrationIds,
      input,
      db,
    );

    return NextResponse.json(outcome, { status: 201 });
  } catch (error) {
    if (error instanceof RegistrationDocumentError) {
      return toRegistrationDocumentErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
