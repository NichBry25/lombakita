import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listHostChecks } from "@/server/host-trust/host-check-decision-service";

// GET: the staff host check queue, open checks on live drafts, oldest first. platform_ops only, with
// the MFA the role gate enforces. It reads only and acts on no account, so it carries no Rule 16
// guard.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const hostChecks = await listHostChecks();
    return NextResponse.json({ hostChecks });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
