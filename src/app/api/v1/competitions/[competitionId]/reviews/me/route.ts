import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  CompetitionReviewError,
  toCompetitionReviewErrorResponse,
} from "@/server/competitions/competition-reviews-core";
import { getMyReview, upsertMyReview } from "@/server/competitions/competition-reviews-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    const { competitionId } = await context.params;
    const review = await getMyReview(session.user.id, competitionId);
    return NextResponse.json({ review });
  } catch (error) {
    if (error instanceof CompetitionReviewError) {
      return toCompetitionReviewErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["candidate"]);
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return toCompetitionReviewErrorResponse(
        new CompetitionReviewError("review_invalid_payload", "Request body must be valid JSON"),
      );
    }
    const review = await upsertMyReview(session.user.id, competitionId, body);
    return NextResponse.json({ review });
  } catch (error) {
    if (error instanceof CompetitionReviewError) {
      return toCompetitionReviewErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
