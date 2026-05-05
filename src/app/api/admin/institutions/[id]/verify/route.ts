import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  parseVerifyInput,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import { verifyInstitution } from "@/server/institution-verification/verification-service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new VerificationError("verification_invalid_payload", 400, "Invalid JSON body");
    }

    const input = parseVerifyInput(body);

    const result = await verifyInstitution({
      institutionId: id,
      targetStatus: input.targetStatus,
      reason: input.reason,
      actorUserId: session.user.id,
      actorRole: session.user.role,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof VerificationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
