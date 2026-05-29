import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { disbandTeam, getTeamForViewer, updateTeam } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ teamId: string }> };

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

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { teamId } = await context.params;
    const result = await getTeamForViewer(session.user.id, teamId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { teamId } = await context.params;
    const payload = await parseJsonBody(request);
    const team = await updateTeam(session.user.id, teamId, payload);
    return NextResponse.json({ team });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { teamId } = await context.params;
    await disbandTeam(session.user.id, teamId);
    return NextResponse.json({ disbanded: true });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
