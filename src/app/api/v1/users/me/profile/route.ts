import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiAuth } from "@/server/auth/api-guard";
import {
  parseProfilePatch,
  ProfileInputError,
  toProfileInputErrorResponse,
} from "@/server/user-profile/profile-core";
import {
  getOwnerProfile,
  getVerificationState,
  updateOwnerProfile,
} from "@/server/user-profile/profile-service";

// GET /api/v1/users/me/profile
// Returns the authenticated owner's full profile with per-field scope indicators.
export const GET = withApiAuth(async (_request, session) => {
  const profile = await getOwnerProfile(session.user.id);
  return NextResponse.json({ profile });
});

// PATCH /api/v1/users/me/profile
// Updates the owner's profile. Enforces field-scope server-side:
//   - candidate-scoped fields require candidateVerifiedAt IS NOT NULL
//   - recruiter-scoped fields require recruiterVerifiedAt IS NOT NULL
// Returns 422 with profile_scope_violation for any scope violation.
export const PATCH = withApiAuth(async (request, session) => {
  try {
    // Cross-session form-submission guard. See assertSessionMatchesExpectedUser doc.
    assertSessionMatchesExpectedUser(request, session);

    // Fetch verification state from DB — session token does not carry these timestamps.
    const verificationState = await getVerificationState(session.user.id);

    if (!verificationState) {
      return NextResponse.json({ error: { code: "unauthenticated" } }, { status: 401 });
    }

    const payload = await request.json();
    const patch = parseProfilePatch(
      payload,
      verificationState.candidateVerified,
      verificationState.recruiterVerified,
    );
    const profile = await updateOwnerProfile(session.user.id, patch);

    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof ProfileInputError) {
      return toProfileInputErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return toProfileInputErrorResponse(
        new ProfileInputError(
          "profile_invalid_payload",
          "Profile update payload must be valid JSON",
        ),
      );
    }

    throw error;
  }
});
