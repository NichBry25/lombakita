import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  elevateRecruiterTier,
  parseElevationInput,
  RecruiterTierElevationError,
} from "@/server/recruiter-tier/recruiter-tier-service";

// Platform-ops manual recruiter tier elevation.
// Only `platform_ops` may call this endpoint. Only `tier: 'elevated'` is accepted as a target.
// The endpoint is idempotent — repeated calls on an account already at `elevated` return 200
// with `changed: false` rather than an error.
//
// No automated mechanical verification flow exists at launch; this endpoint is the sole path
// from `minimal` to `elevated`.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { accountId } = await context.params;

    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new RecruiterTierElevationError("tier_invalid_payload", 400, "Account id is required");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new RecruiterTierElevationError(
        "tier_invalid_payload",
        400,
        "Request body must be valid JSON",
      );
    }

    parseElevationInput(body);

    const result = await elevateRecruiterTier(session.user.id, accountId);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof RecruiterTierElevationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
