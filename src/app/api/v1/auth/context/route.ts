import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireCurrentUserDomainContext } from "@/server/user-domain/tenant-access";

export async function GET(): Promise<Response> {
  try {
    const context = await requireCurrentUserDomainContext();

    return NextResponse.json({
      user: context,
    });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
