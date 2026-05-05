import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  InstitutionInvitationError,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import {
  createInstitutionInvitation,
  listPendingInvitations,
} from "@/server/institution-invitations/invitation-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const invitations = await listPendingInvitations(session.user.id, institutionSlug);

    return NextResponse.json({ invitations });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }

    return toAccessDeniedResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const payload = await request.json();
    const result = await createInstitutionInvitation(session.user.id, institutionSlug, payload);

    return NextResponse.json({ invitation: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          error: { code: "invitation_invalid_payload", message: "Request body must be valid JSON" },
        },
        { status: 400 },
      );
    }

    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }

    return toAccessDeniedResponse(error);
  }
}
