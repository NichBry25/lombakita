import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  CompetitionEligibilityInputError,
  getCompetitionEligibilityForEditor,
  setCompetitionEligibilityForEditor,
} from "@/server/competitions/competition-eligibility-service";

const toErrorResponse = (error: CompetitionEligibilityInputError): Response =>
  NextResponse.json(
    { error: { code: error.code, message: error.message } },
    {
      status: error.httpStatus,
    },
  );

export async function GET(
  _request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { competitionId } = await context.params;
    const eligibilityNote = await getCompetitionEligibilityForEditor(
      session.user.id,
      competitionId,
    );
    return NextResponse.json({ eligibilityNote });
  } catch (error) {
    if (error instanceof CompetitionEligibilityInputError) return toErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ competitionId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const { competitionId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return toErrorResponse(
        new CompetitionEligibilityInputError(
          "competition_eligibility_invalid_payload",
          "Request body must be valid JSON",
        ),
      );
    }
    const eligibilityNote = await setCompetitionEligibilityForEditor(
      session.user.id,
      competitionId,
      body,
    );
    return NextResponse.json({ eligibilityNote });
  } catch (error) {
    if (error instanceof CompetitionEligibilityInputError) return toErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
