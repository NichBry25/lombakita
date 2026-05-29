import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { inviteTeamMember } from "@/server/teams/team-service";

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

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { teamId } = await context.params;
    const payload = await parseJsonBody(request);
    const invitation = await inviteTeamMember(session.user.id, teamId, payload);
    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
