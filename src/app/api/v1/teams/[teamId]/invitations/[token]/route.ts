import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { cancelTeamInvitationByToken } from "@/server/teams/team-service";

// G6 (Step 6.5b): cancel route is now token-keyed (tokenHash in URL), consistent with the
// accept and decline routes at /api/v1/team-invitations/[token]/*.
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
