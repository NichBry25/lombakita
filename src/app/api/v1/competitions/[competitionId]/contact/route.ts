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
  getCompetitionOrganizerContactForEditor,
  setCompetitionOrganizerContactForEditor,
} from "@/server/competitions/competition-organizer-contact-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const contactForEditor = await getCompetitionOrganizerContactForEditor(
      session.user.id,
      competitionId,
    );
    return NextResponse.json(contactForEditor);
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    // Rule 16: a contact rendered for Account A must not land on Account B after a cookie flip.
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
    const contact = await setCompetitionOrganizerContactForEditor(
      session.user.id,
      competitionId,
      body,
    );
    return NextResponse.json({ contact });
  } catch (error) {
    if (error instanceof CompetitionError) return toCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
