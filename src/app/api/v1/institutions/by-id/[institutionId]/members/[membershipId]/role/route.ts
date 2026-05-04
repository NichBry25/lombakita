import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  MemberError,
  parseRoleChangeBody,
  toMemberErrorResponse,
} from "@/server/institution-members/member-core";
import { changeMemberRole } from "@/server/institution-members/member-service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ institutionId: string; membershipId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionId, membershipId } = await context.params;
    const payload = await request.json();
    const { role } = parseRoleChangeBody(payload);
    await changeMemberRole(session.user.id, institutionId, membershipId, role);

    return NextResponse.json({ updated: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: { code: "member_invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    if (error instanceof MemberError) {
      return toMemberErrorResponse(error);
    }

    return toAccessDeniedResponse(error);
  }
}
