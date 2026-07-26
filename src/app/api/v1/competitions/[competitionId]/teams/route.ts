import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { createTeam, getTeamForCompetitionAndCandidate } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ competitionId: string }> };

const parseJsonBody = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new TeamError("team_invalid_payload", "Request body must be JSON");
  }
  try {
    return await request.json();
  } catch {
    throw new TeamError("team_invalid_payload", "Request body must be valid JSON");
  }
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    const payload = await parseJsonBody(request);
    const team = await createTeam(session.user.id, competitionId, payload);
    return NextResponse.json({ team }, { status: 201 });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

// Convenience GET: returns the calling candidate's current team for this competition (or null).
// Used by the minimal proof team page so it can render either the create form or the roster.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId } = await context.params;
    const result = await getTeamForCompetitionAndCandidate(session.user.id, competitionId);
    return NextResponse.json({ team: result });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
