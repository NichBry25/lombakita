import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listRecruiterVerificationQueue } from "@/server/recruiter-verification/recruiter-verification-service";

// GET — recruiter trust review queue: submissions awaiting review first (priority-ordered:
// vouched → corporate email → documents → oldest), then rejected submissions the recruiter may
// still reopen. platform_ops only. Priority reorders the queue; approval is always a human
// decision.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const submissions = await listRecruiterVerificationQueue();
    return NextResponse.json({ submissions });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
