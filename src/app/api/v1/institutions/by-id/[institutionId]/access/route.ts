import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireCurrentUserInstitutionAccess } from "@/server/user-domain/tenant-access";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionId: string }> },
): Promise<Response> {
  try {
    const { institutionId } = await context.params;

    const access = await requireCurrentUserInstitutionAccess({
      institutionId,
    });

    return NextResponse.json({
      access: {
        institutionId,
        membershipRole: access.membership.membershipRole,
        membershipStatus: access.membership.membershipStatus,
      },
    });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
