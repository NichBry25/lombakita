import { NextResponse } from "next/server";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { getTeamInvitationMetaByToken } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ token: string }> };

// Unauthenticated metadata lookup. Used by the invite landing page to render team name,
// competition title, and inviter. Does NOT expose roster — the invitee may not be on the team
// yet, so showing roster is information leakage.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { token } = await context.params;
    if (!token) throw new TeamError("team_invite_not_found", "Token missing");
    const meta = await getTeamInvitationMetaByToken(token);
    return NextResponse.json({ invitation: meta });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    throw error;
  }
}
