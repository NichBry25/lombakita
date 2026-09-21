import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
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
    // The service re-resolves the actor from the database and refuses a caller whose account does
    // not exist, does not hold `platform_ops`, or is suspended (LAUNCH-D72). A session that passed
    // `requireSessionRole` and then fails here is a session the database has since contradicted.
    //
    // THE CODE IS ECHOED, DELIBERATELY. The alternative is a single generic denial, and the reason it
    // is not the right answer here is that these three codes describe the CALLER'S OWN ACCOUNT and
    // nothing else. The caller reached this branch only by passing `requireSessionRole`, and the three
    // states behind the codes are "your account was deleted", "your role was revoked", "you were
    // suspended" — facts about the caller that the caller has a claim to, and that the session it
    // still holds is actively misrepresenting. Nothing here names a property of `accountId`: all
    // three refusals are thrown before the target is read, which the ordering test in
    // `operator-actor-db.integration.test.ts` pins. A route that collapsed these into one would leave
    // a genuine operator with a stale session and no way to tell which of the three had happened.
    if (error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
