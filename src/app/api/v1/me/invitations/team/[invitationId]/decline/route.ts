import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { TeamError, toTeamErrorResponse } from "@/server/teams/team-core";
import { declineTeamInvitationForUser } from "@/server/teams/team-service";

// In-app team invitation decline (reject). Session-id matched; same model as accept.
// CLAUDE.md Rule #16 applies (own data).
export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { invitationId } = await context.params;
    await declineTeamInvitationForUser(invitationId, session.user.id);

    return NextResponse.json({ declined: true });
  } catch (error) {
    if (error instanceof TeamError) {
      return toTeamErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
