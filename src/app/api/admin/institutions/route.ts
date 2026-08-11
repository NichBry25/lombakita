import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listInstitutionsForPlatformOps } from "@/server/institution-verification/verification-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get("status") ?? undefined;
    const page = Number.parseInt(searchParams.get("page") ?? "1", 10);

    const result = await listInstitutionsForPlatformOps({
      actorRole: session.user.role,
      statusFilter,
      page: Number.isNaN(page) ? 1 : page,
    });

    return NextResponse.json(result);
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
