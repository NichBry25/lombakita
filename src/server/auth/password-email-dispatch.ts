import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import { describeEmailFailure, emailFailureClassOf } from "@/server/email/send-failure";

export type PasswordEmailKind =
  | "password_reset"
  | "password_reset_google_notice"
  | "password_changed";

/**
 * Runs one password-recovery send, once, and absorbs its failure.
 *
 * The visitor is never told whether a send failed, so a failure is reported here and nowhere else.
 * Neither the log nor the Sentry event carries the recipient address or the token: a provider's
 * message can quote the address it refused, so the event is built from the failure's class and
 * codes rather than from the error's own message.
 */
export const dispatchPasswordEmail = async (
  context: { userId: string; kind: PasswordEmailKind },
  send: () => Promise<void>,
): Promise<void> => {
  try {
    await send();
  } catch (error) {
    const failure = describeEmailFailure(error);
    const reason = emailFailureClassOf(error) ?? "unexpected";

    logger.error("auth.password_reset_email.dispatch_failed", {
      userId: context.userId,
      kind: context.kind,
      reason,
      providerCode: failure.providerCode,
      statusCode: failure.statusCode,
    });

    Sentry.captureException(
      new Error(`Password email dispatch failed: ${context.kind} (${reason})`),
      { level: "error", tags: { subsystem: "auth-password-reset-email" } },
    );
  }
};
