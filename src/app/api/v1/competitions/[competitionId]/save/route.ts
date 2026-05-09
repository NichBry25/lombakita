import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  saveCompetition,
  unsaveCompetition,
  SavedCompetitionError,
  toSavedCompetitionErrorResponse,
} from "@/server/saved-competitions/saved-competition-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["student"]);
    const { competitionId } = await context.params;
    await saveCompetition(session.user.id, competitionId);
    return NextResponse.json({ saved: true });
  } catch (error) {
    if (error instanceof SavedCompetitionError) return toSavedCompetitionErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["student"]);
    const { competitionId } = await context.params;
    await unsaveCompetition(session.user.id, competitionId);
    return NextResponse.json({ saved: false });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
