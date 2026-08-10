import { NextResponse } from "next/server";
import { confirmMfaEnrolment } from "@/server/auth/mfa/factor-service";
import { issueMfaElevationGrant } from "@/server/auth/mfa/mfa-elevation";
import { parseMfaCodeBody, withMfaRouteAuth } from "@/server/auth/mfa/mfa-route-guard";

// Confirms a pending MFA enrolment with the first code from the operator's authenticator app.
// On success this also elevates the CURRENT session (mirrors challenge/route.ts) — having just
// proven the factor works is exactly the proof the challenge route asks for, so the operator is
// not immediately re-challenged one page later. Returns the ten recovery codes in plaintext: this
// response is their only appearance anywhere.
export const POST = withMfaRouteAuth(async (request, session) => {
  const parsed = await parseMfaCodeBody(request);
  if ("error" in parsed) {
    return parsed.error;
  }

  const { recoveryCodes } = await confirmMfaEnrolment(session.user.id, parsed.code, new Date());

  // Enrolment has already committed at this point (factor verified, recovery codes minted), and
  // this response is the only place the recovery codes ever appear. Elevation is a convenience on
  // top of a successful enrolment, not a condition of one, so a failure to mint the grant must not
  // become an error response that takes the codes with it.
  //
  // The window is narrow: the fail-closed limiter in `withMfaRouteAuth` refuses this request before
  // the handler runs when Redis is already unreachable, so the case left here is Redis failing
  // between the two calls. Narrow is not zero, and what it costs is unrecoverable.
  let elevationGrantId: string | null = null;
  try {
    elevationGrantId = await issueMfaElevationGrant(session.user.id);
  } catch {
    elevationGrantId = null;
  }

  return NextResponse.json({ recoveryCodes, elevationGrantId });
});
