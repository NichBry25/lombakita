import { NextResponse } from "next/server";
import { challengeMfaFactor } from "@/server/auth/mfa/factor-service";
import { issueMfaElevationGrant } from "@/server/auth/mfa/mfa-elevation";
import { parseMfaCodeBody, withMfaRouteAuth } from "@/server/auth/mfa/mfa-route-guard";

// Verifies a TOTP code against the account's already-verified factor and, on success, mints the
// single-use elevation grant the client passes to `useSession().update()`. The jwt callback is the
// only place that grant is ever trusted (server/auth/mfa/mfa-elevation.ts) — this route hands the
// CLIENT nothing but an opaque id.
export const POST = withMfaRouteAuth(async (request, session) => {
  const parsed = await parseMfaCodeBody(request);
  if ("error" in parsed) {
    return parsed.error;
  }

  await challengeMfaFactor(session.user.id, parsed.code, new Date());

  let elevationGrantId: string;
  try {
    elevationGrantId = await issueMfaElevationGrant(session.user.id);
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "mfa_elevation_unavailable",
          message: "Verification succeeded but the session could not be elevated — try again",
        },
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ elevationGrantId });
});
