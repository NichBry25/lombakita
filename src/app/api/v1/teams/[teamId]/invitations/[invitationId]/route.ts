import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { cancelTeamInvitation } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ teamId: string; invitationId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { teamId, invitationId } = await context.params;
    await cancelTeamInvitation(session.user.id, teamId, invitationId);
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
