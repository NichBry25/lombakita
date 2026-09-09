/**
 * The outcome of a web-originated send, resolved before the response is built.
 *
 * The four web-process send sites dispatched their email fire-and-forget and attached a `.catch`
 * that logged and swallowed. That put the failure somewhere no operator looks: the action reported
 * success, the owner was never told, and the only record was a log line nobody reads until an
 * incident. These are low-frequency platform_ops actions, so waiting for the provider costs an
 * admin under a second and buys a truthful answer.
 *
 * The state change is NOT conditional on delivery. Verification has already committed by the time
 * this runs, and a failed notification must never roll it back — the outcome rides alongside the
 * result so the surface can say "verified, but the email did not go out" rather than either lying
 * about the email or lying about the verification.
 *
 * `@sentry/nextjs` here is correct and is the reason this is a separate module from the worker's
 * reporter: this one only ever runs inside the Next.js server runtime.
 */

import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/email/delivery-outcome");

import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import { describeEmailFailure, type EmailFailureClass } from "@/server/email/send-failure";

export type EmailDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; failureClass: EmailFailureClass };

export const DELIVERED: EmailDeliveryOutcome = Object.freeze({ delivered: true });

/**
 * Waits for a send, reports any failure to the log and to Sentry, and returns what happened.
 *
 * Never rejects: the caller has already committed its state change, so a throw here would turn a
 * successful action into a failed request.
 */
export const awaitDeliveryAndReportFailure = async (
  task: Promise<void>,
  context: { event: string; institutionId: string },
): Promise<EmailDeliveryOutcome> => {
  try {
    await task;
    return DELIVERED;
  } catch (error: unknown) {
    const failure = describeEmailFailure(error);

    logger.error("email.delivery_failed", {
      event: context.event,
      institutionId: context.institutionId,
      failureClass: failure.failureClass,
      providerCode: failure.providerCode,
      statusCode: failure.statusCode,
      detail: failure.detail,
    });

    Sentry.captureException(error, {
      tags: {
        emailFailureClass: failure.failureClass,
        emailEvent: context.event,
      },
      extra: {
        institutionId: context.institutionId,
        providerCode: failure.providerCode,
        statusCode: failure.statusCode,
      },
    });

    return { delivered: false, failureClass: failure.failureClass };
  }
};
