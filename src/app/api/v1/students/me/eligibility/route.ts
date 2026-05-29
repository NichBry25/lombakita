import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  EligibilityInputError,
  toEligibilityInputErrorResponse,
} from "@/server/eligibility/eligibility-core";
import {
  checkStudentEligibility,
  getStudentEligibilityProfile,
  updateStudentEligibilityProfile,
} from "@/server/eligibility/eligibility-service";

export const GET = withApiRole(["candidate"], async (_request, session) => {
  const profile = await getStudentEligibilityProfile(session.user.id);
  const eligibility = await checkStudentEligibility(session.user.id);

  return NextResponse.json({
    profile,
    eligibility,
  });
});

export const PATCH = withApiRole(["candidate"], async (request, session) => {
  try {
    // Cross-session form-submission guard: reject if the page that rendered this form was
    // rendered for a different user than the active session (multi-tab/multi-account race).
    assertSessionMatchesExpectedUser(request, session);
    const payload = await request.json();
    const result = await updateStudentEligibilityProfile(session.user.id, payload);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EligibilityInputError) {
      return toEligibilityInputErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return toEligibilityInputErrorResponse(
        new EligibilityInputError(
          "eligibility_invalid_payload",
          "Eligibility update payload must be valid JSON",
        ),
      );
    }

    throw error;
  }
});
