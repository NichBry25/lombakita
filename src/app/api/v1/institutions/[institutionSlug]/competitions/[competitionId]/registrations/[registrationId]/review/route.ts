import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  ReviewError,
  toReviewErrorResponse,
  parseReviewUpdatePayload,
  updateRegistrationReview,
} from "@/server/participants/review-service";

// Institution-internal review update. Admin tooling acting on another user's
// registration — CCR-09 (institution_member excluded) is enforced by
// requireAdminInstitutionBySlug. Per CLAUDE.md Rule #16 the cross-session
// session-match guard is intentionally NOT applied (this does not act on the
// caller's own data).
export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
  },
) {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId, actorMembershipId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const body = await request.json().catch(() => null);
    const patch = parseReviewUpdatePayload(body);

    const result = await updateRegistrationReview(
      institutionId,
      competitionId,
      registrationId,
      patch,
      actorMembershipId,
      db,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReviewError) {
      return toReviewErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
