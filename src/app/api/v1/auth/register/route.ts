import { NextResponse } from "next/server";
import {
  CredentialsAuthError,
  isSignupRole,
  registerUserWithCredentials,
} from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import { REGISTRATION_RATE_LIMIT } from "@/server/auth/rate-limit-constants";
import { rateLimitedResponse } from "@/server/auth/rate-limit-response";
import { checkFixedWindowLimit } from "@/server/redis/rate-limit";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export async function POST(request: Request): Promise<Response> {
  // BEFORE the body is parsed and before any row is written: registration is unauthenticated
  // account-creation that also bills a verification send, so an unbounded endpoint amplifies both.
  //
  // FAIL-OPEN (checkFixedWindowLimit), matching identify and credentials login. A Redis outage
  // taking every new signup offline is a larger and far likelier harm than the abuse this bounds,
  // and unlike the MFA routes there is no account under attack here to justify the opposite trade.
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const rate = await checkFixedWindowLimit({
    key: `${REGISTRATION_RATE_LIMIT.keyPrefix}${clientIp}`,
    limit: REGISTRATION_RATE_LIMIT.limit,
    windowSeconds: REGISTRATION_RATE_LIMIT.windowSeconds,
  });
  if (!rate.allowed) {
    return rateLimitedResponse(rate.retryAfterSeconds);
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
