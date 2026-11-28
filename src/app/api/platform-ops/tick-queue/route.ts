import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { listTickQueue } from "@/server/institution-verification/name-check-service";

// GET: the staff Centang queue, pending tick requests, name checks due and running name proofs.
// platform_ops only, with the MFA the role gate enforces. It reads only and acts on no account, so it
// carries no Rule 16 guard.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const tickQueue = await listTickQueue();
    return NextResponse.json({ tickQueue });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
