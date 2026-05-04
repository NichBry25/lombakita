import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { listActiveMembers } from "@/server/institution-members/member-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionId } = await context.params;
    const members = await listActiveMembers(session.user.id, institutionId);

    return NextResponse.json({ members });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
