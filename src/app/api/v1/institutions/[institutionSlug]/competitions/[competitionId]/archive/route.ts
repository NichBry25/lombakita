import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
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
  _request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    await assertCompetitionInInstitution(institutionSlug.trim().toLowerCase(), competitionId);
    const result = await transitionCompetitionStatus(session.user.id, competitionId, "archived");
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
