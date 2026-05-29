import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  saveCompetition,
  unsaveCompetition,
  SavedCompetitionError,
  toSavedCompetitionErrorResponse,
} from "@/server/saved-competitions/saved-competition-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    await saveCompetition(session.user.id, competitionId);
    return NextResponse.json({ saved: true });
  } catch (error) {
    if (error instanceof SavedCompetitionError) return toSavedCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    await unsaveCompetition(session.user.id, competitionId);
    return NextResponse.json({ saved: false });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
