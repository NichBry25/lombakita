import { after, NextResponse } from "next/server";
import { extractClientIp, UNKNOWN_CLIENT_IP } from "@/server/auth/client-ip";
import { CredentialsAuthError, normalizeEmail } from "@/server/auth/credentials-auth";
import { toCredentialsAuthErrorResponse } from "@/server/auth/credentials-auth-api";
import { dispatchPasswordEmail } from "@/server/auth/password-email-dispatch";
import { sendPasswordChangedEmail } from "@/server/auth/password-reset-email";
import { confirmPasswordReset } from "@/server/auth/password-reset";
import { loginFailedAttemptKey } from "@/server/auth/rate-limit-constants";
import { clearFailedAttempts } from "@/server/redis/rate-limit";

// Completing a reset proves control of the mailbox, so the person on this device is no longer a
// guesser. The sign-in lock is keyed by (IP, email), so only the device that completed the reset is
// released. Sign-in skips the lock for an unresolvable IP, so there is no key to clear then.
const clearSignInLockForThisDevice = async (request: Request, email: string): Promise<void> => {
  const clientIp = extractClientIp((name) => request.headers.get(name));
  if (clientIp === UNKNOWN_CLIENT_IP) return;

  await clearFailedAttempts(loginFailedAttemptKey(clientIp, normalizeEmail(email)));
};

/**
 * Sets a new password from a reset link.
 *
 * No limiter: the token is 256 bits and is judged before any password is hashed, so a guess costs
 * the caller a lookup and the server nothing more.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json();
    const { userId, email, name } = await confirmPasswordReset(payload);

    await clearSignInLockForThisDevice(request, email);

    after(() =>
      dispatchPasswordEmail({ userId, kind: "password_changed" }, () =>
        sendPasswordChangedEmail({ email, name }),
      ),
    );

    return NextResponse.json({ reset: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return toCredentialsAuthErrorResponse(
        new CredentialsAuthError("invalid_payload", 400, "Payload must be valid JSON"),
      );
    }

    return toCredentialsAuthErrorResponse(error);
  }
}
