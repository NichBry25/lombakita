import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
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
import { resolveCompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
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
    //
    // Publish readiness rides this same read. The publish control has to keep telling the truth
    // after a save changes the answer — clearing the personal reach cap, setting a fee, fixing a
    // date — and the shells already re-run this request after every successful mutation. A second
    // endpoint for one boolean would be a second thing to keep in step with the first.
    const [hasActiveRegistrations, participation, publishReadiness] = await Promise.all([
      hasActiveRegistrationsForCompetition(competitionId),
      getCompetitionParticipationSummary(competition),
      resolveCompetitionPublishReadiness(session.user.id, competitionId),
    ]);
    return NextResponse.json({
      competition,
      hasActiveRegistrations,
      participation,
      publishReadiness,
    });
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
    // Rule 16 — a field edit acts on the calling user's own draft (mirrors
    // api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route.ts:25). A save
    // rendered for Account A must not land on Account B after a cookie flip in the same browser.
    assertSessionMatchesExpectedUser(request, session);
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
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    // Rule 16 — deleting acts on the calling user's own draft (mirrors
    // api/v1/institutions/[institutionSlug]/competitions/[competitionId]/publish/route.ts:25). The same
    // cookie flip that would publish Account B's competition would delete it.
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    await softDeleteCompetitionDraft(session.user.id, competitionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
