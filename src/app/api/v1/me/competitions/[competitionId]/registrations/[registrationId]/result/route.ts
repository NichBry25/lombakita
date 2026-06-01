import { NextResponse } from "next/server";
import { requireSessionRole } from "@/server/auth/session";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { getPublishedResultForCandidate } from "@/server/participants/result-service";

type RouteContext = {
  params: Promise<{ competitionId: string; registrationId: string }>;
};

// GET — returns result_label and result_notes only when the result is published.
// Returns 404 (no-info-leak) when absent, unpublished, or the registration does not
// belong to the requesting candidate.
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId, registrationId } = await context.params;

    const result = await getPublishedResultForCandidate(
      session.user.id,
      competitionId,
      registrationId,
    );

    if (!result) {
      return NextResponse.json(
        { error: { code: "result_not_found", message: "Result not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ result });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
