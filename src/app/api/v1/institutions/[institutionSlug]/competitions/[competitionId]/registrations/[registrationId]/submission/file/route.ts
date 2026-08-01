import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  SubmissionFileError,
  resolveSubmissionFileUrlForInstitution,
  toSubmissionFileErrorResponse,
} from "@/server/participants/submission-file-service";

// Mints a short-lived presigned GET for the file a participant submitted, for an organizer who
// owns the competition.
//
// `inline` is a preference, not a command: the service honours it only for a content type this
// app will render in a tab, and forces an opaque attachment download otherwise. Submission
// uploads carry no magic-byte validation, so the served content type is never taken from the
// candidate's declaration without that gate.
//
// This access is audited in the service — the row is written before the URL is minted.
//
// No Rule 16 cross-session guard: this route acts on another user's data (the participant's),
// authorized by institution membership, not by the caller's own account.
export async function GET(
  request: Request,
  context: {
    params: Promise<{
      institutionSlug: string;
      competitionId: string;
      registrationId: string;
    }>;
  },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    );

    const requested = new URL(request.url).searchParams.get("disposition");
    const disposition = requested === "attachment" ? "attachment" : "inline";

    const result = await resolveSubmissionFileUrlForInstitution(
      institutionId,
      session.user.id,
      competitionId,
      registrationId,
      disposition,
      db,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SubmissionFileError) {
      return toSubmissionFileErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
