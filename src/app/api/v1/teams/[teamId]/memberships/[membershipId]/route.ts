import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { removeTeamMember } from "@/server/teams/team-service";

type RouteContext = { params: Promise<{ teamId: string; membershipId: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { teamId, membershipId } = await context.params;
    await removeTeamMember(session.user.id, teamId, membershipId);
    return NextResponse.json({ removed: true });
  } catch (error) {
    if (error instanceof TeamError) return toTeamErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
