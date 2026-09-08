import { NextResponse } from "next/server";
import {
  CredentialsAuthError,
  resendRegistrationVerification,
} from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import {
  REGISTRATION_RESEND_EMAIL_LIMIT,
  REGISTRATION_RESEND_IP_LIMIT,
} from "@/server/auth/rate-limit-constants";
import { rateLimitedResponse } from "@/server/auth/rate-limit-response";
import { checkFixedWindowLimit } from "@/server/redis/rate-limit";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * The address a request is asking to mail, normalised for use as a counter key.
 *
 * Lower-cased and trimmed so `A@x.com ` and `a@x.com` share one bucket; without that, an attacker
 * varies the case and gets a fresh allowance per spelling.
 */
const resendTargetOf = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const email = payload.email;

  return typeof email === "string" && email.trim() !== "" ? email.trim().toLowerCase() : null;
};

/**
 * Resends a registration verification email.
 *
 * Unauthenticated, and it bills a provider send per call, so it is the one endpoint in this area
 * that is an email amplifier by construction. Two limiters, because one key cannot cover both
 * shapes of the abuse: the IP key stops a single host sweeping the endpoint, and the address key
 * stops a distributed caller having the platform mail one person indefinitely.
 *
 * Both are FAIL-OPEN, matching identify and credentials login (DEC-0098). A Redis outage that
 * blocked every verification resend would lock out exactly the users who cannot get in yet, which
 * is a worse and likelier harm than the abuse being bounded. The MFA routes fail closed instead
 * because they protect an authenticated factor and keep a second, Postgres-backed bound; neither
 * applies here.
 */
export async function POST(request: Request): Promise<Response> {
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const ipRate = await checkFixedWindowLimit({
    key: `${REGISTRATION_RESEND_IP_LIMIT.keyPrefix}${clientIp}`,
    limit: REGISTRATION_RESEND_IP_LIMIT.limit,
    windowSeconds: REGISTRATION_RESEND_IP_LIMIT.windowSeconds,
  });
  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

  try {
    const payload = await request.json();
    const target = resendTargetOf(payload);

    if (target) {
      // COUNTED BEFORE THE LOOKUP, so the cap is reached at the same rate whether or not the
      // address has an account. A counter advanced only by real sends would cap known addresses
      // alone, making the 429 itself an existence oracle.
      const addressRate = await checkFixedWindowLimit({
        key: `${REGISTRATION_RESEND_EMAIL_LIMIT.keyPrefix}${target}`,
        limit: REGISTRATION_RESEND_EMAIL_LIMIT.limit,
        windowSeconds: REGISTRATION_RESEND_EMAIL_LIMIT.windowSeconds,
      });
      if (!addressRate.allowed) {
        return rateLimitedResponse(addressRate.retryAfterSeconds);
      }
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
