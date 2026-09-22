import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import {
  assertCompetitionInInstitution,
  transitionCompetitionStatus,
} from "@/server/competitions/competition-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    // Rule 16 — publishing acts on the calling user's own institution (mirrors
    // api/v1/candidate/me/profile/route.ts:40). A publish rendered for Account A must not land on
    // Account B after a cookie flip in the same browser.
    assertSessionMatchesExpectedUser(request, session);
    const { institutionSlug, competitionId } = await context.params;
    await assertCompetitionInInstitution(institutionSlug.trim().toLowerCase(), competitionId);
    const result = await transitionCompetitionStatus(session.user.id, competitionId, "published");
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
