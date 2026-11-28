import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  toVerificationErrorResponse,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import {
  InstitutionWorkspaceInputError,
  toInstitutionWorkspaceInputErrorResponse,
} from "@/server/institution-workspace/institution-core";
import {
  renameInstitutionAsStaff,
  type RenameInstitutionAsStaffInput,
} from "@/server/institution-workspace/institution-staff-rename-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

type RouteParams = { params: Promise<{ institutionId: string }> };

const readBodyOrEmpty = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const renameInputFrom = (body: Record<string, unknown>): RenameInstitutionAsStaffInput => {
  const input: RenameInstitutionAsStaffInput = {
    reason: typeof body.reason === "string" ? body.reason : "",
  };
  if ("displayName" in body) input.displayName = body.displayName;
  if ("slug" in body) input.slug = body.slug;
  return input;
};

// Rename a workspace or change its address. platform_ops only. Body: { displayName?, slug?, reason }.
// It acts on another party's workspace, so it carries no Rule 16 guard.
export async function PATCH(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { institutionId } = await params;
    const body = await readBodyOrEmpty(request);

    const institution = await renameInstitutionAsStaff(
      session.user.id,
      institutionId,
      renameInputFrom(body),
    );
    return NextResponse.json({ institution }, { status: 200 });
  } catch (error) {
    if (error instanceof InstitutionWorkspaceInputError) {
      return toInstitutionWorkspaceInputErrorResponse(error);
    }
    if (error instanceof VerificationError) {
      return toVerificationErrorResponse(error);
    }
    if (error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
