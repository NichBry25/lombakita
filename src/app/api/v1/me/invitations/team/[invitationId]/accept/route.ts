import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { acceptTeamInvitationForUser } from "@/server/teams/team-service";

// In-app team invitation acceptance. Addressed by id (from the caller's inbox), accepted
// ONLY when session.user.id === target_user_id (enforced in the service). Acts on the caller's OWN
// data → CLAUDE.md Rule #16. The candidate-verification gate fires server-side at the accept
// mutation (team membership is candidate-scoped).
export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { invitationId } = await context.params;
    const result = await acceptTeamInvitationForUser(invitationId, session.user.id);

    return NextResponse.json({ accepted: true, teamId: result.teamId });
  } catch (error) {
    if (error instanceof TeamError) {
      return toTeamErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
