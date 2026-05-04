import { NextResponse } from "next/server";
import {
  InstitutionInvitationError,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import { getInvitationMetaByToken } from "@/server/institution-invitations/invitation-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await context.params;
    const meta = await getInvitationMetaByToken(token);

    return NextResponse.json({ invitation: meta });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }

    return NextResponse.json(
      { error: { code: "internal_error", message: "Failed to retrieve invitation" } },
      { status: 500 },
    );
  }
}
