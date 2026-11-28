import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  assertRecruiterTier,
  INSTITUTION_CREATION_MIN_TIER,
  RecruiterTierError,
} from "@/server/auth/recruiter-tier";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import { createInstitutionWorkspaceForUser } from "@/server/institution-workspace/institution-service";

// Workspace creation for every kind, for an account that holds the host role (withApiRole) at the
// minimal recruiter tier or above (INSTITUTION_CREATION_MIN_TIER). A candidate-only session receives
// 403 at this layer before any payload processing.
export const POST = withApiRole(["recruiter"], async (request, session) => {
  // Rule #16: the caller creates an institution they will own, so a request whose rendered-for user
  // no longer matches the active session (cross-tab or multi-account race) is refused.
  assertSessionMatchesExpectedUser(request, session);

  try {
    await assertRecruiterTier(session, INSTITUTION_CREATION_MIN_TIER);
    const payload = await request.json();
    const institution = await createInstitutionWorkspaceForUser(session.user.id, payload);

    return NextResponse.json(
      {
        institution,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RecruiterTierError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }

    if (error instanceof InstitutionWorkspaceInputError) {
      return toInstitutionWorkspaceInputErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return toInstitutionWorkspaceInputErrorResponse(
        new InstitutionWorkspaceInputError(
          "institution_invalid_payload",
          "Institution payload must be valid JSON",
        ),
      );
    }

    throw error;
  }
});
