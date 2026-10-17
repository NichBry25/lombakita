import { after, NextResponse } from "next/server";
import { CredentialsAuthError, parseEmailPayload } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { extractClientIp } from "@/server/auth/client-ip";
import { dispatchPasswordEmail } from "@/server/auth/password-email-dispatch";
import {
  sendPasswordResetEmail,
  sendPasswordResetGoogleNoticeEmail,
} from "@/server/auth/password-reset-email";
import {
  requestPasswordReset,
  type PasswordResetRequestOutcome,
} from "@/server/auth/password-reset";
import {
  PASSWORD_RESET_ADDRESS_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
} from "@/server/auth/rate-limit-constants";
import {
  checkClientIpBound,
  checkOptionalBound,
  rateLimitedResponse,
} from "@/server/auth/rate-limit-response";
import { verificationEmailTargetOf } from "@/server/auth/verification-email-target";

const scheduleResetEmail = (outcome: PasswordResetRequestOutcome): void => {
  if (outcome.action === "none") {
    return;
  }

  const { userId, email, name } = outcome;

  if (outcome.action === "send_reset") {
    const { rawToken } = outcome;
    after(() =>
      dispatchPasswordEmail({ userId, kind: "password_reset" }, () =>
        sendPasswordResetEmail({ email, name, rawToken }),
      ),
    );
    return;
  }

  after(() =>
    dispatchPasswordEmail({ userId, kind: "password_reset_google_notice" }, () =>
      sendPasswordResetGoogleNoticeEmail({ email, name }),
    ),
  );
};

/**
 * Requests a password-reset link.
 *
 * Unauthenticated and mail-sending, so it is bounded twice, FAIL-OPEN (DEC-0098): a Redis outage
 * must not stop a locked-out user asking for a link. The response is `{ "requested": true }` for
 * every address and every account state; what is mailed is decided after the response is built, so
 * nothing the caller sees depends on the account.
 */
export async function POST(request: Request): Promise<Response> {
  const clientIp = extractClientIp((name) => request.headers.get(name));
  const ipRate = await checkClientIpBound(clientIp, PASSWORD_RESET_IP_LIMIT);

  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

  try {
    const payload = await request.json();
    // COUNTED BEFORE THE LOOKUP, so the cap is reached at the same rate whether or not the address
    // has an account. A counter advanced only by real sends would make the 429 an existence oracle.
    const target = verificationEmailTargetOf(payload);
    const addressRate = await checkOptionalBound(target, PASSWORD_RESET_ADDRESS_LIMIT);

    if (!addressRate.allowed) {
      return rateLimitedResponse(addressRate.retryAfterSeconds);
    }

    const { email } = parseEmailPayload(payload);
    const outcome = await requestPasswordReset(email);
    scheduleResetEmail(outcome);

    return NextResponse.json({ requested: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
