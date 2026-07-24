import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionRoundsInputError,
  toCompetitionRoundsErrorResponse,
} from "@/server/competitions/competition-rounds-core";
import {
  getCompetitionRoundsForEditor,
  setCompetitionRoundsForEditor,
} from "@/server/competitions/competition-rounds-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const rounds = await getCompetitionRoundsForEditor(session.user.id, competitionId);
    return NextResponse.json({ rounds });
  } catch (error) {
    if (error instanceof CompetitionRoundsInputError) {
      return toCompetitionRoundsErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return toCompetitionRoundsErrorResponse(
        new CompetitionRoundsInputError(
          "competition_rounds_invalid_payload",
          "Request body must be valid JSON",
        ),
      );
    }
    const rounds = await setCompetitionRoundsForEditor(session.user.id, competitionId, body);
    return NextResponse.json({ rounds });
  } catch (error) {
    if (error instanceof CompetitionRoundsInputError) {
      return toCompetitionRoundsErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
