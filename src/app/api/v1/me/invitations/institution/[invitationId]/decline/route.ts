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
import { declineInstitutionInvitationForUser } from "@/server/institution-invitations/invitation-service";

// In-app institution invitation decline (reject). Session-id matched; same
// ownership/non-leak model as accept. CLAUDE.md Rule #16 applies (own data).
export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { invitationId } = await context.params;
    await declineInstitutionInvitationForUser(invitationId, session.user.id);

    return NextResponse.json({ declined: true });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
