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
import { assertCompetitionInInstitution } from "@/server/competitions/competition-service";
import { publishOrOpenHostCheck } from "@/server/host-trust/host-check-service";

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
    const result = await publishOrOpenHostCheck(session.user.id, competitionId);
    if (result.outcome === "host_check_opened") {
      return NextResponse.json({ hostCheck: result.hostCheck }, { status: 202 });
    }
    return NextResponse.json({ competition: result.competition });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
