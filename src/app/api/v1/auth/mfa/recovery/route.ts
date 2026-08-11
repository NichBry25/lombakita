import { NextResponse } from "next/server";
import { redeemMfaRecoveryCode } from "@/server/auth/mfa/factor-service";
import { parseMfaCodeBody, withMfaRouteAuth } from "@/server/auth/mfa/mfa-route-guard";

// Redeems a recovery code. This is a RESET, not a login: on success the factor is gone and
// `users.mfa_invalidated_at` is stamped, so the account (and every other outstanding session it
// holds) lands back in `enrolment_required` on its next session read. No elevation grant is issued
// here — the point is to let the operator back into the ENROLMENT flow to set up a fresh factor,
// not to hand out standing operational access on a code meant for exactly one emergency use.
export const POST = withMfaRouteAuth(async (request, session) => {
  const parsed = await parseMfaCodeBody(request);
  if ("error" in parsed) {
    return parsed.error;
  }

  await redeemMfaRecoveryCode(session.user.id, parsed.code, new Date());

  return NextResponse.json({ reset: true });
});
