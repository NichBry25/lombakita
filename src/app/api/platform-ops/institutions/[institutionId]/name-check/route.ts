import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  decideNameCheck,
  type NameCheckDecision,
} from "@/server/institution-verification/name-check-service";
import { VerificationError } from "@/server/institution-verification/verification-core";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

type RouteContext = { params: Promise<{ institutionId: string }> };

const invalidPayload = (message: string): Response =>
  NextResponse.json({ error: { code: "invalid_payload", message } }, { status: 400 });

// A reason that is not a string reads as absent, so the service's own refusal names what is missing.
const parseDecisionBody = (body: unknown): NameCheckDecision | null => {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const reason = typeof raw.reason === "string" ? raw.reason : undefined;
  if (raw.decision === "name_ok") {
    return reason === undefined ? { decision: "name_ok" } : { decision: "name_ok", reason };
  }
  if (raw.decision !== "require_proof") return null;
  return { decision: "require_proof", reason: reason ?? "" };
};

// POST: the staff decision on the name of a workspace ticked by its organization email. platform_ops
// only, with the MFA the role gate enforces. It acts on another party's workspace, so it carries no
// Rule 16 guard. The service reads the actor from the database again.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { institutionId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidPayload("Request body must be valid JSON");
    }

    const decision = parseDecisionBody(body);
    if (!decision) return invalidPayload("decision must be 'name_ok' or 'require_proof'");

    const nameCheck = await decideNameCheck(session.user.id, institutionId, decision);
    return NextResponse.json({ nameCheck });
  } catch (error) {
    if (error instanceof VerificationError || error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
