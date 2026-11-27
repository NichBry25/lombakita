import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  HostTrustRemovalError,
  removeHostTrust,
} from "@/server/host-trust/host-trust-removal-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

type RouteContext = { params: Promise<{ accountId: string }> };

// A body without a string reason reaches the service as an empty reason, so the service's own
// refusal names what is missing.
const reasonOf = (body: unknown): string => {
  if (typeof body !== "object" || body === null) return "";
  const raw = body as Record<string, unknown>;
  return typeof raw.reason === "string" ? raw.reason : "";
};

// POST: staff remove a host's trust with a reason. platform_ops only, with the MFA the role gate
// enforces. It acts on another account, so it carries no Rule 16 guard. The service reads the actor
// from the database again and refuses the actor's own account.
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { accountId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_payload", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    const removal = await removeHostTrust(session.user.id, accountId, reasonOf(body));
    return NextResponse.json(removal);
  } catch (error) {
    if (error instanceof HostTrustRemovalError || error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
