import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  listInstitutionVerificationSubmissions,
  SubmissionError,
} from "@/server/institution-verification/submission-service";

type RouteContext = { params: Promise<{ institutionSlug: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;

    const submissions = await listInstitutionVerificationSubmissions(
      institutionSlug,
      session.user.id,
    );

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
