import { NextResponse } from "next/server";
import { AccessError, toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { acceptTeamInvitation } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ token: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    // Session must be confirmed before token lookup so the unauthenticated branch is
    // distinguishable from invalid-token branches in the UI.
    const session = await requireSessionRole(["candidate"]);
    const { token } = await context.params;
    if (!token) {
      throw new TeamError("team_invite_not_found", "Token missing");
    }
    const result = await acceptTeamInvitation(token, session.user.id);
    return NextResponse.json({ accepted: true, teamId: result.teamId });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    if (error instanceof AccessError) return toAccessDeniedResponse(error);
    throw error;
  }
}
