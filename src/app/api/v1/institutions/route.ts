import { NextResponse } from "next/server";
import { withApiRole } from "@/server/auth/api-guard";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import { createInstitutionWorkspaceForUser } from "@/server/institution-workspace/institution-service";

// CCR-05 / DEC-0039: institution creation is gated to recruiter-verified accounts only.
// A candidate-only session receives 403 at this layer before any payload processing.
export const POST = withApiRole(["recruiter"], async (request, session) => {
  try {
    const payload = await request.json();
    const institution = await createInstitutionWorkspaceForUser(session.user.id, payload);

    return NextResponse.json(
      {
        institution,
      },
      { status: 201 },
    );
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

    throw error;
  }
});
