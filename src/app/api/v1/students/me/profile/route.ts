import { NextResponse } from "next/server";
import { withApiRole } from "@/server/auth/api-guard";
import {
  StudentProfileInputError,
  toStudentProfileInputErrorResponse,
} from "@/server/student-profile/profile-core";
import {
  getStudentProfileForUser,
  updateStudentProfileForUser,
} from "@/server/student-profile/profile-service";

export const GET = withApiRole(["candidate"], async (_request, session) => {
  const profile = await getStudentProfileForUser(session.user.id);

  return NextResponse.json({
    profile,
  });
});

export const PATCH = withApiRole(["candidate"], async (request, session) => {
  try {
    const payload = await request.json();
    const profile = await updateStudentProfileForUser(session.user.id, payload);

    return NextResponse.json({
      profile,
    });
  } catch (error) {
    if (error instanceof StudentProfileInputError) {
      return toStudentProfileInputErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return toStudentProfileInputErrorResponse(
        new StudentProfileInputError(
          "profile_invalid_payload",
          "Profile update payload must be valid JSON",
        ),
      );
    }

    throw error;
  }
});
