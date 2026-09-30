import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import {
  DeidentificationError,
  deidentifyAccount,
  parseDeidentifyInput,
} from "@/server/accounts/account-deidentification-service";

// Platform-ops account de-identification, on the account owner's request.
//
// Only `platform_ops` may call this endpoint. It is not idempotent in the way the elevation route
// is: a second call on an account that has been de-identified is refused with
// `deidentify_already_done` rather than answered with a no-op, because "already done" and "done
// just now" are different facts and the operator needs the first one to be told.
//
// The typed confirmation is compared in the service, against the username the database holds at the
// moment of the write — never against anything this request carried.
export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { accountId } = await context.params;

    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new DeidentificationError("deidentify_invalid_payload", 400, "Account id is required");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new DeidentificationError(
        "deidentify_invalid_payload",
        400,
        "Request body must be valid JSON",
      );
    }

    const input = parseDeidentifyInput(body);

    const result = await deidentifyAccount(session.user.id, accountId, input);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof DeidentificationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    // The service re-resolves the actor from the database, twice — once to answer whether the
    // caller may act on this target at all, once inside the transaction that writes (LAUNCH-D72,
    // LAUNCH-D141). A session that passed `requireSessionRole` and then fails here is a session the
    // database has since contradicted.
    //
    // THE CODE IS ECHOED for the same reason the elevation route echoes it: these codes describe
    // the CALLER'S OWN ACCOUNT, and nothing here names a property of `accountId`. The three
    // resolution failures are thrown before the target is read, and `operator_actor_is_target`
    // compares the caller's own resolved id against `accountId` without reading the target row.
    if (error instanceof OperatorActorError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return toAccessDeniedResponse(error);
  }
}
