import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import {
  cancelCompetitionForInsufficientParticipation,
  confirmCompetitionWillProceed,
} from "@/server/competitions/competition-participation-service";
import { assertCompetitionInInstitution } from "@/server/competitions/competition-service";

type ParticipationDecision = "cancel" | "proceed";

const parseDecision = async (request: Request): Promise<ParticipationDecision> => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be valid JSON",
    );
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("decision" in payload) ||
    ((payload as { decision?: unknown }).decision !== "cancel" &&
      (payload as { decision?: unknown }).decision !== "proceed")
  ) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "decision must be either 'cancel' or 'proceed'",
    );
  }

  return (payload as { decision: ParticipationDecision }).decision;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string; competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    await assertCompetitionInInstitution(institutionSlug.trim().toLowerCase(), competitionId);
    const decision = await parseDecision(request);
    const result =
      decision === "cancel"
        ? await cancelCompetitionForInsufficientParticipation(session.user.id, competitionId)
        : await confirmCompetitionWillProceed(session.user.id, competitionId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
