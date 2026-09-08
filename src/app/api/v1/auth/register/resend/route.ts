import { NextResponse } from "next/server";
import {
  CredentialsAuthError,
  resendRegistrationVerification,
} from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import {
  REGISTRATION_RESEND_IP_LIMIT,
  VERIFICATION_EMAIL_ADDRESS_LIMIT,
} from "@/server/auth/rate-limit-constants";
import {
  checkClientIpBound,
  checkOptionalBound,
  rateLimitedResponse,
} from "@/server/auth/rate-limit-response";
import { verificationEmailTargetOf } from "@/server/auth/verification-email-target";

/**
 * Resends a registration verification email.
 *
 * Unauthenticated, and it bills a provider send per call, so it is the one endpoint in this area
 * that is an email amplifier by construction. Two limiters, because one key cannot cover both
 * shapes of the abuse: the IP key stops a single host sweeping the endpoint, and the address key
 * stops a distributed caller having the platform mail one person indefinitely.
 *
 * The address budget is the one /register also draws from, so alternating the two endpoints cannot
 * collect both allowances against one victim.
 *
 * Both are FAIL-OPEN, matching identify and credentials login (DEC-0098). A Redis outage that
 * blocked every verification resend would lock out exactly the users who cannot get in yet, which
 * is a worse and likelier harm than the abuse being bounded. The MFA routes fail closed instead
 * because they protect an authenticated factor and keep a second, Postgres-backed bound; neither
 * applies here.
 */
export async function POST(request: Request): Promise<Response> {
  // An unresolvable client IP collapses every caller into one bucket, which would take the endpoint
  // offline for everybody the moment a forwarded header goes missing. Skipped rather than shared,
  // the same trade the credentials login path makes. The address bound below still applies.
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const ipRate = await checkClientIpBound(clientIp, REGISTRATION_RESEND_IP_LIMIT);

  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

  try {
    const payload = await request.json();
    // COUNTED BEFORE THE LOOKUP, so the cap is reached at the same rate whether or not the address
    // has an account. A counter advanced only by real sends would cap known addresses alone, making
    // the 429 itself an existence oracle.
    const target = verificationEmailTargetOf(payload);
    const addressRate = await checkOptionalBound(target, VERIFICATION_EMAIL_ADDRESS_LIMIT);

    if (!addressRate.allowed) {
      return rateLimitedResponse(addressRate.retryAfterSeconds);
    }

    const result = await resendRegistrationVerification(payload);

    return NextResponse.json({
      resend: result,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
