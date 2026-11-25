import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  decideHostCheck,
  HostCheckDecisionError,
  type HostCheckDecisionInput,
} from "@/server/host-trust/host-check-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

type RouteContext = { params: Promise<{ checkId: string }> };

const invalidPayload = (message: string): Response =>
  NextResponse.json({ error: { code: "invalid_payload", message } }, { status: 400 });

// A turn-down with a missing item or note reaches the service as an empty string, so the service's
// own refusal names what is missing.
const parseDecisionBody = (body: unknown): HostCheckDecisionInput | null => {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (raw.decision === "approve") return { decision: "approve" };
  if (raw.decision !== "turn_down") return null;
  return {
    decision: "turn_down",
    guidelineItem: typeof raw.guidelineItem === "string" ? raw.guidelineItem : "",
    note: typeof raw.note === "string" ? raw.note : "",
  };
};

// POST: the staff decision on one host check. platform_ops only, with the MFA the role gate
// enforces. It acts on another account, so it carries no Rule 16 guard. The service reads the actor
// from the database again and refuses a decision on the actor's own check.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { checkId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidPayload("Request body must be valid JSON");
    }

    const decision = parseDecisionBody(body);
    if (!decision) return invalidPayload("decision must be 'approve' or 'turn_down'");

    const hostCheck = await decideHostCheck(session.user.id, checkId, decision);
    return NextResponse.json({ hostCheck });
  } catch (error) {
    if (error instanceof HostCheckDecisionError || error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
