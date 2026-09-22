import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  parseVerifyInput,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import { verifyInstitution } from "@/server/institution-verification/verification-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
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
    // The acting account was refused by the database, including `operator_actor_conflicted` — this
    // operator belongs to the institution they are deciding. Echoed the way the recruiter-tier route
    // echoes it (accounts/[accountId]/recruiter-tier/route.ts:69-74).
    if (error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
