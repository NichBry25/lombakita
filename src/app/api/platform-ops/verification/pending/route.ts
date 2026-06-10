import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  listPendingVerificationSubmissions,
  SubmissionError,
} from "@/server/institution-verification/submission-service";

export async function GET(): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const submissions = await listPendingVerificationSubmissions(session.user.role);
    return NextResponse.json({ submissions });
  } catch (error) {
    if (error instanceof SubmissionError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
