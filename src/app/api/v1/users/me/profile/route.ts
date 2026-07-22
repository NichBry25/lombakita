import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiAuth } from "@/server/auth/api-guard";
import {
  parseProfilePatch,
  ProfileInputError,
  toProfileInputErrorResponse,
} from "@/server/user-profile/profile-core";
import { getOwnerProfile, updateOwnerProfile } from "@/server/user-profile/profile-service";

// GET /api/v1/users/me/profile
// Returns the authenticated owner's full profile (scalar fields + detail collections).
export const GET = withApiAuth(async (_request, session) => {
  const profile = await getOwnerProfile(session.user.id);
  return NextResponse.json({ profile });
});

// PATCH /api/v1/users/me/profile
// Updates the owner's scalar profile fields (all shared — no per-role scope gating). Detail
// collections (experience, education, skills, certifications, social links) have their own
// sub-resource endpoints.
export const PATCH = withApiAuth(async (request, session) => {
  try {
    // Cross-session form-submission guard. See assertSessionMatchesExpectedUser doc.
    assertSessionMatchesExpectedUser(request, session);

    const payload = await request.json();
    const patch = parseProfilePatch(payload);
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
