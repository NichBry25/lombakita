import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  InstitutionProfileInputError,
  toInstitutionProfileInputErrorResponse,
} from "@/server/institution-workspace/institution-profile-core";
import {
  getInstitutionProfileForOwnerBySlug,
  updateInstitutionProfileForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const profile = await getInstitutionProfileForOwnerBySlug(session.user.id, institutionSlug);
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof InstitutionProfileInputError) {
      return toInstitutionProfileInputErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const { institutionSlug } = await context.params;
    const payload = await request.json();
    const profile = await updateInstitutionProfileForOwnerBySlug(
      session.user.id,
      institutionSlug,
      payload,
    );
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof InstitutionProfileInputError) {
      return toInstitutionProfileInputErrorResponse(error);
    }
    if (error instanceof SyntaxError) {
      return toInstitutionProfileInputErrorResponse(
        new InstitutionProfileInputError(
          "institution_profile_invalid_payload",
          "Institution profile payload must be valid JSON",
        ),
      );
    }
    return toAccessDeniedResponse(error);
  }
}
