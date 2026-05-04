import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  InstitutionInvitationError,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import { cancelInvitation } from "@/server/institution-invitations/invitation-service";

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string; id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, id } = await context.params;
    await cancelInvitation(session.user.id, institutionSlug, id);

    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }

    return toAccessDeniedResponse(error);
  }
}
