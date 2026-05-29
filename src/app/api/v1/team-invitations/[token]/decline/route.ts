import { NextResponse } from "next/server";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { declineTeamInvitation } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ token: string }> };

// Unauthenticated decline. Intentionally returns no team or roster metadata — only that the
// decline succeeded. Matches the institution_invitations decline pattern.
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { token } = await context.params;
    if (!token) throw new TeamError("team_invite_not_found", "Token missing");
    await declineTeamInvitation(token);
    return NextResponse.json({ declined: true });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    throw error;
  }
}
