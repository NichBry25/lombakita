import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionError,
  parseCompetitionPatchInput,
  toCompetitionErrorResponse,
} from "@/server/competitions/competition-core";
import {
  getCompetitionForReader,
  softDeleteCompetitionDraft,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";
import { hasActiveRegistrationsForCompetition } from "@/server/competitions/competition-access";
import { getCompetitionParticipationSummary } from "@/server/competitions/competition-participation-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const competition = await getCompetitionForReader(
      session.user.id,
      session.user.role,
      competitionId,
    );
    // Reported alongside the competition so the console can show the withdrawal control's real
    // availability rather than offering an action the service will refuse. Access is already
    // narrowed to platform_ops and institution owner/staff, who can list the participants
    // themselves, so this exposes nothing new.
    const [hasActiveRegistrations, participation] = await Promise.all([
      hasActiveRegistrationsForCompetition(competitionId),
      getCompetitionParticipationSummary(competition),
    ]);
    return NextResponse.json({ competition, hasActiveRegistrations, participation });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

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
    const patch = parseCompetitionPatchInput(body);
    const competition = await updateCompetitionDraft(session.user.id, competitionId, patch);
    return NextResponse.json({ competition });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    await softDeleteCompetitionDraft(session.user.id, competitionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
