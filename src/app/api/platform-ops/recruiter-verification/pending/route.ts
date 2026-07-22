import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listPendingRecruiterVerifications } from "@/server/recruiter-verification/recruiter-verification-service";

// GET — priority-ordered recruiter trust review queue (vouched → corporate email → documents →
// oldest). platform_ops only. Priority reorders the queue; approval is always a human decision.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const submissions = await listPendingRecruiterVerifications();
    return NextResponse.json({ submissions });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
