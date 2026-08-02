import { NextResponse } from "next/server";
import {
  CredentialsAuthError,
  isSignupRole,
  registerUserWithCredentials,
} from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export async function POST(request: Request): Promise<Response> {
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
