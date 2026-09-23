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
  unpublishCompetition,
} from "@/server/competitions/competition-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    // Rule 16 — unpublishing acts on the calling user's own competition (mirrors
    // api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route.ts:25). A control
    // rendered for Account A must not act on Account B after a cookie flip in the same browser.
    assertSessionMatchesExpectedUser(request, session);
    const { institutionSlug, competitionId } = await context.params;
    await assertCompetitionInInstitution(institutionSlug.trim().toLowerCase(), competitionId);
    const result = await unpublishCompetition(session.user.id, competitionId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
