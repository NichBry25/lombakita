import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionTagsInputError,
  toCompetitionTagsErrorResponse,
} from "@/server/competitions/competition-tags-core";
import {
  getCompetitionTagsForEditor,
  setCompetitionTagsForEditor,
} from "@/server/competitions/competition-tags-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const tags = await getCompetitionTagsForEditor(session.user.id, competitionId);
    return NextResponse.json({ tags });
  } catch (error) {
    if (error instanceof CompetitionTagsInputError) {
      return toCompetitionTagsErrorResponse(error);
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
      return toCompetitionTagsErrorResponse(
        new CompetitionTagsInputError(
          "competition_tags_invalid_payload",
          "Request body must be valid JSON",
        ),
      );
    }
    const tags = await setCompetitionTagsForEditor(session.user.id, competitionId, body);
    return NextResponse.json({ tags });
  } catch (error) {
    if (error instanceof CompetitionTagsInputError) {
      return toCompetitionTagsErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
