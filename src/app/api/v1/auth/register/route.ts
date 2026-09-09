import { NextResponse } from "next/server";
import {
  CredentialsAuthError,
  isSignupRole,
  registerUserWithCredentials,
} from "@/server/auth/credentials-auth";
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

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
    const url = new URL(request.url);
    // The role declaration is read from the `?as=` query param. Bodies that also carry
    // `signupRole` or `role` are merged in parseRegistrationInput as a fallback so callers
    // (tests, native apps) that cannot easily shape a URL can still supply the declaration
    // explicitly. The server REJECTS a missing / unknown declaration — there is no silent default.
    const querySignupRole = url.searchParams.get("as");
    const rawPayload = await request.json();
    const payload = isRecord(rawPayload) ? { ...rawPayload } : rawPayload;

    if (isRecord(payload) && querySignupRole !== null) {
      if (isSignupRole(querySignupRole)) {
        payload.signupRole = querySignupRole;
      } else {
        return toCredentialsAuthErrorResponse(
          new CredentialsAuthError(
            "invalid_signup_role",
            400,
            "Signup role declaration is required: use ?as=candidate or ?as=recruiter",
          ),
        );
      }
    }

    // The per-address budget, shared with /register/resend. Registering an address that already
    // exists but is unverified re-sends the verification email rather than being refused, so this
    // endpoint mails a caller-named address exactly as the resend endpoint does and has to draw
    // from the same allowance. Counted before the address is looked up, so the 429 arrives at the
    // same point whether or not an account exists.
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
