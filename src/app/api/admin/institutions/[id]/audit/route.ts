import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { getInstitutionVerificationAudit } from "@/server/institution-verification/verification-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { id } = await context.params;

    const entries = await getInstitutionVerificationAudit(id, session.user.role);

    return NextResponse.json({ entries });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
