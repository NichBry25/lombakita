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
import { generateInstitutionLogoUploadUrl } from "@/server/institution-workspace/institution-service";

// POST — presign a direct-to-R2 PUT for the organizer logo and store the key. Owner-only; personal
// institutions and unconfigured storage are refused by the service. Body: { contentType }.
export async function POST(
  request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    const { institutionSlug } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return toInstitutionProfileInputErrorResponse(
        new InstitutionProfileInputError(
          "institution_profile_invalid_payload",
          "Request body must be valid JSON",
        ),
      );
    }

    const contentType =
      typeof (body as Record<string, unknown>)?.contentType === "string"
        ? ((body as Record<string, unknown>).contentType as string)
        : "";
    if (!contentType.startsWith("image/")) {
      return toInstitutionProfileInputErrorResponse(
        new InstitutionProfileInputError(
          "institution_profile_invalid_value",
          "contentType must be an image mime type",
          { fields: ["contentType"] },
        ),
      );
    }

    const result = await generateInstitutionLogoUploadUrl(session.user.id, institutionSlug, {
      contentType,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof InstitutionProfileInputError) {
      return toInstitutionProfileInputErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
