import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  InstitutionInvitationError,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import { acceptInstitutionInvitationForUser } from "@/server/institution-invitations/invitation-service";

// In-app institution invitation acceptance. The invitation is addressed by id (from the
// caller's inbox) and accepted ONLY when session.user.id === target_user_id (enforced in the
// service). Acts on the caller's OWN data, so CLAUDE.md Rule #16 applies: the cross-session guard
// runs immediately after the auth gate. The recruiter-verification gate fires server-side in
// the service at the accept mutation.
export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { invitationId } = await context.params;
    await acceptInstitutionInvitationForUser(
      invitationId,
      session.user.id,
      session.user.verifiedRoles,
    );

    return NextResponse.json({ accepted: true });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
