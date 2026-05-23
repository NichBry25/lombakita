import { NextResponse } from "next/server";
import { AccessError, toAccessDeniedResponse } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import {
  InstitutionInvitationError,
  toInstitutionInvitationErrorResponse,
} from "@/server/institution-invitations/invitation-core";
import { acceptInvitation } from "@/server/institution-invitations/invitation-service";
import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";

const resolveBaseUrl = (): string => {
  return serverEnv.authUrl ?? serverEnv.appBaseUrl ?? publicEnv.appUrl ?? "http://localhost:3000";
};

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  // Session check MUST happen before any token lookup per security spec.
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    const { token } = await context.params;
    const callbackUrl = `${resolveBaseUrl()}/invitations/${encodeURIComponent(token)}/accept`;

    return NextResponse.json(
      {
        error: {
          code: "unauthenticated",
          message: "Authentication required to accept an invitation",
          callbackUrl,
        },
      },
      { status: 401 },
    );
  }

  try {
    const { token } = await context.params;
    await acceptInvitation(token, session.user.id, session.user.verifiedRoles ?? []);

    return NextResponse.json({ accepted: true });
  } catch (error) {
    if (error instanceof InstitutionInvitationError) {
      return toInstitutionInvitationErrorResponse(error);
    }

    if (error instanceof AccessError) {
      return toAccessDeniedResponse(error);
    }

    return NextResponse.json(
      { error: { code: "internal_error", message: "Failed to accept invitation" } },
      { status: 500 },
    );
  }
}
