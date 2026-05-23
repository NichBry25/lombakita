import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { MemberError, toMemberErrorResponse } from "@/server/institution-members/member-core";
import { removeMember } from "@/server/institution-members/member-service";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string; membershipId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, membershipId } = await context.params;
    await removeMember(session.user.id, institutionSlug, membershipId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof MemberError) {
      return toMemberErrorResponse(error);
    }

    return toAccessDeniedResponse(error);
  }
}
