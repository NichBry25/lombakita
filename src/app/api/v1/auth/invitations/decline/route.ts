import { NextResponse } from "next/server";
import {
  InstitutionInvitationError,
  parseDeclineBody,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import { declineInvitation } from "@/server/institution-invitations/invitation-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json();
    const { token } = parseDeclineBody(payload);
    await declineInvitation(token);

    return NextResponse.json({ declined: true });
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

    return NextResponse.json(
      { error: { code: "internal_error", message: "Failed to decline invitation" } },
      { status: 500 },
    );
  }
}
