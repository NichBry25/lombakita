import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  CandidateProfileError,
  parseCandidateProfileUpdatePatch,
  toCandidateProfileErrorResponse,
} from "@/server/candidate/candidate-profile-core";
import {
  getCandidateProfile,
  updateCandidateProfile,
} from "@/server/candidate/candidate-profile-service";

// GET /api/v1/candidate/me/profile
// Returns the authenticated candidate's onboarding profile (or null when none exists).
export const GET = withApiRole(["candidate"], async (_request, session) => {
  const profile = await getCandidateProfile(session.user.id);
  return NextResponse.json({ profile });
});

// PATCH /api/v1/candidate/me/profile
// Edits the candidate's onboarding fields from the /candidate-dashboard editor. Returns 404 when
// the candidate has no profile row yet (the row is created at registration).
export const PATCH = withApiRole(["candidate"], async (request, session) => {
  try {
    // Cross-session form-submission guard. See assertSessionMatchesExpectedUser doc.
    assertSessionMatchesExpectedUser(request, session);

    const payload = await request.json();
    const patch = parseCandidateProfileUpdatePatch(payload);
    const profile = await updateCandidateProfile(session.user.id, patch);

    if (!profile) {
      return NextResponse.json(
        {
          error: {
            code: "candidate_profile_not_found",
            message: "No candidate profile exists for this account",
          },
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof CandidateProfileError) {
      return toCandidateProfileErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return toCandidateProfileErrorResponse(
        new CandidateProfileError(
          "candidate_profile_invalid_payload",
          "Candidate profile update payload must be valid JSON",
        ),
      );
    }

    throw error;
  }
});
