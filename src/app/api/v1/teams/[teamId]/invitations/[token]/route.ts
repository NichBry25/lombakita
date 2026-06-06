import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { cancelTeamInvitationByToken } from "@/server/teams/team-service";

// G6 (Step 6.5b): captain-side cancel route is token-keyed (tokenHash in URL). Step 6.5e retired
// the token accept/decline routes — recipient acceptance is now in-app and session-id matched at
// /api/v1/me/invitations/team/[invitationId]/{accept,decline}. This captain cancel is unchanged.
type RouteContext = { params: Promise<{ teamId: string; token: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { teamId, token } = await context.params;
    await cancelTeamInvitationByToken(session.user.id, teamId, token);
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
