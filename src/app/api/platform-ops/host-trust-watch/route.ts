import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listHostTrustWatch } from "@/server/host-trust/host-trust-watch-service";

// GET: the staff watch of new trusts on an organization domain whose host staff removed in the last
// 90 days. platform_ops only, with the MFA the role gate enforces. It reads only and acts on no
// account, so it carries no Rule 16 guard.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const watchList = await listHostTrustWatch();
    return NextResponse.json({ watchList });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
