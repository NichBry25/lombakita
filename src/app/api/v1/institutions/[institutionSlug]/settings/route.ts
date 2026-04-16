import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import {
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ institutionSlug: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const institution = await getInstitutionWorkspaceForOwnerBySlug(
      session.user.id,
      institutionSlug,
    );

    return NextResponse.json({
      institution,
    });
  } catch (error) {
    if (error instanceof InstitutionWorkspaceInputError) {
      return toInstitutionWorkspaceInputErrorResponse(error);
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
    const { institutionSlug } = await context.params;
    const payload = await request.json();
    const institution = await updateInstitutionWorkspaceForOwnerBySlug(
      session.user.id,
      institutionSlug,
      payload,
    );

    return NextResponse.json({
      institution,
    });
  } catch (error) {
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

    return toAccessDeniedResponse(error);
  }
}
