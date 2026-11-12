import { NextResponse } from "next/server";
import { CredentialsAuthError, verifyRegistrationEmailCode } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import { REGISTRATION_CODE_IP_LIMIT } from "@/server/auth/rate-limit-constants";
import { checkClientIpBound, rateLimitedResponse } from "@/server/auth/rate-limit-response";

/**
 * Verifies an email address by the code mailed to it.
 *
 * Public and unauthenticated: no session exists before the address is verified.
 *
 * The IP bound is the broad-sweep bound and FAILS OPEN, the house direction for the self-service
 * auth routes (DEC-0098): a Redis outage must not lock out the people who cannot get in yet. It does
 * not bound guessing. The per-code and per-account guessing limits inside the service FAIL CLOSED,
 * by the developer's stop rule.
 */
export async function POST(request: Request): Promise<Response> {
  // An unresolvable client IP is skipped rather than shared, the same trade the resend route makes.
  // The guessing limits inside the service still apply.
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const ipRate = await checkClientIpBound(clientIp, REGISTRATION_CODE_IP_LIMIT);

  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

  try {
    const payload = await request.json();
    const result = await verifyRegistrationEmailCode(payload);

    return NextResponse.json({ verify: result });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
