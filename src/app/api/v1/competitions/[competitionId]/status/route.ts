import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  parseStatusTransitionInput,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import { transitionCompetitionStatus } from "@/server/competitions/competition-service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new CompetitionError(
        "competition_invalid_payload",
        400,
        "Request body must be valid JSON",
      );
    }
    const { targetStatus } = parseStatusTransitionInput(body);
    const result = await transitionCompetitionStatus(session.user.id, competitionId, targetStatus);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
