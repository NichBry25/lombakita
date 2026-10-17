import { after, NextResponse } from "next/server";
import { CredentialsAuthError } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiAuth } from "@/server/auth/api-guard";
import { dispatchPasswordEmail } from "@/server/auth/password-email-dispatch";
import { sendPasswordChangedEmail } from "@/server/auth/password-reset-email";
import { changePassword } from "@/server/auth/password-reset";
import { rateLimitedResponse } from "@/server/auth/rate-limit-response";

const limiterUnavailableResponse = (): NextResponse =>
  NextResponse.json(
    {
      error: {
        code: "rate_limit_unavailable",
        message: "Layanan sementara tidak tersedia. Coba lagi beberapa saat.",
      },
    },
    { status: 503 },
  );

const readJsonObject = async (request: Request): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must be a JSON object");
  }

  return body as Record<string, unknown>;
};

/**
 * Changes the signed-in account's own password, then signs it out everywhere.
 *
 * `withApiAuth` refuses an operational session whose MFA is not satisfied
 * (`requireAuthenticatedSession` asserts it unless `allowUnsatisfiedMfa` is passed). The wrong-guess
 * limiter fails CLOSED (DEC-0098): when Redis cannot confirm the count, nothing is verified.
 */
export const POST = withApiAuth(async (request, session) => {
  assertSessionMatchesExpectedUser(request, session);

  try {
    const body = await readJsonObject(request);
    const result = await changePassword({
      userId: session.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    if (result.outcome === "limiter_unavailable") {
      return limiterUnavailableResponse();
    }

    if (result.outcome === "rate_limited") {
      return rateLimitedResponse(result.retryAfterSeconds);
    }

    const { email, name } = result;
    after(() =>
      dispatchPasswordEmail({ userId: session.user.id, kind: "password_changed" }, () =>
        sendPasswordChangedEmail({ email, name }),
      ),
    );

    return NextResponse.json({ changed: true });
  } catch (error) {
    if (error instanceof CredentialsAuthError) {
      return toCredentialsAuthErrorResponse(error);
    }

    throw error;
  }
});
