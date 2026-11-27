import { NextResponse } from "next/server";
import { CredentialsAuthError, registerUserWithCredentials } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import {
  REGISTRATION_RATE_LIMIT,
  VERIFICATION_EMAIL_ADDRESS_LIMIT,
} from "@/server/auth/rate-limit-constants";
import {
  checkClientIpBound,
  checkOptionalBound,
  rateLimitedResponse,
} from "@/server/auth/rate-limit-response";
import { verificationEmailTargetOf } from "@/server/auth/verification-email-target";

export async function POST(request: Request): Promise<Response> {
  // BEFORE the body is parsed and before any row is written: registration is unauthenticated
  // account-creation that also bills a verification send, so an unbounded endpoint amplifies both.
  //
  // An unresolvable client IP collapses every caller into one bucket, which would take signup
  // offline for everybody the moment a forwarded header goes missing. Skipped rather than shared,
  // the same trade the credentials login path makes. The address bound below still applies.
  //
  // FAIL-OPEN (checkFixedWindowLimit), matching identify and credentials login. A Redis outage
  // taking every new signup offline is a larger and far likelier harm than the abuse this bounds,
  // and unlike the MFA routes there is no account under attack here to justify the opposite trade.
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const ipRate = await checkClientIpBound(clientIp, REGISTRATION_RATE_LIMIT);

  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

  try {
    const payload: unknown = await request.json();

    // The per-address budget, shared with /register/resend: this endpoint mails a caller-named
    // address, as the resend endpoint does, so it draws from the same allowance. Counted before
    // the address is looked up, so the 429 arrives at the same point whether or not an account
    // exists.
    const target = verificationEmailTargetOf(payload);
    const addressRate = await checkOptionalBound(target, VERIFICATION_EMAIL_ADDRESS_LIMIT);

    if (!addressRate.allowed) {
      return rateLimitedResponse(addressRate.retryAfterSeconds);
    }

    const result = await registerUserWithCredentials(payload);

    return NextResponse.json({
      registration: result,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Registration payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
