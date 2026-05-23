import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { listActiveMembers } from "@/server/institution-members/member-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const members = await listActiveMembers(session.user.id, institutionSlug);

    return NextResponse.json({ members });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
