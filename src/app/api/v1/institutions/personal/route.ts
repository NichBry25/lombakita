import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  assertRecruiterTier,
  PERSONAL_INSTITUTION_CREATION_MIN_TIER,
  RecruiterTierError,
} from "@/server/auth/recruiter-tier";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import { createPersonalInstitutionForUser } from "@/server/institution-workspace/institution-service";

// Step 6.5f.1 — lightweight personal-institution creation. Gated to recruiter-verified accounts
// (withApiRole) that hold at least the minimal recruiter tier (PERSONAL_INSTITUTION_CREATION_MIN_TIER).
// The one-personal-per-recruiter invariant is enforced in createPersonalInstitutionForUser. Distinct
// from POST /api/v1/institutions, which creates a full institution and now requires `elevated`.
//
// There is no request body: a personal institution takes no name or slug input — its name derives
// from the owner username and its slug is derived through the shared slug-uniqueness path. The
// create action is a single submit.
export const POST = withApiRole(["recruiter"], async (request, session) => {
  // Rule #16 — the caller creates an institution they will own; reject a request whose rendered-for
  // user no longer matches the active session (cross-tab / multi-account race).
  assertSessionMatchesExpectedUser(request, session);

  try {
    await assertRecruiterTier(session, PERSONAL_INSTITUTION_CREATION_MIN_TIER);
    const institution = await createPersonalInstitutionForUser(session.user.id);

    return NextResponse.json({ institution }, { status: 201 });
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

    throw error;
  }
});
