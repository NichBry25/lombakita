import { NextResponse } from "next/server";
import { withApiRole } from "@/server/auth/api-guard";
import {
  assertRecruiterTier,
  FULL_INSTITUTION_CREATION_MIN_TIER,
  RecruiterTierError,
} from "@/server/auth/recruiter-tier";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import { createInstitutionWorkspaceForUser } from "@/server/institution-workspace/institution-service";

// Institution creation is gated to recruiter-verified accounts only.
// A candidate-only session receives 403 at this layer before any payload processing.
// Full-institution creation additionally requires the `elevated` recruiter tier
// (FULL_INSTITUTION_CREATION_MIN_TIER). A minimal-tier recruiter who wants a lightweight workspace
// uses the personal-institution path (POST /api/v1/institutions/personal) instead.
export const POST = withApiRole(["recruiter"], async (request, session) => {
  try {
    await assertRecruiterTier(session, FULL_INSTITUTION_CREATION_MIN_TIER);
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
