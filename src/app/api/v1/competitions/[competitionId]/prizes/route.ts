import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionPrizesInputError,
  toCompetitionPrizesErrorResponse,
} from "@/server/competitions/competition-prizes-core";
import {
  getCompetitionPrizesForEditor,
  setCompetitionPrizesForEditor,
} from "@/server/competitions/competition-prizes-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const prizes = await getCompetitionPrizesForEditor(session.user.id, competitionId);
    return NextResponse.json({ prizes });
  } catch (error) {
    if (error instanceof CompetitionPrizesInputError) {
      return toCompetitionPrizesErrorResponse(error);
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
      return toCompetitionPrizesErrorResponse(
        new CompetitionPrizesInputError(
          "competition_prizes_invalid_payload",
          "Request body must be valid JSON",
        ),
      );
    }
    const prizes = await setCompetitionPrizesForEditor(session.user.id, competitionId, body);
    return NextResponse.json({ prizes });
  } catch (error) {
    if (error instanceof CompetitionPrizesInputError) {
      return toCompetitionPrizesErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
