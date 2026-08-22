import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/payment-expiry-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { getAsyncQueue } from "@/server/async/queue";

// Identity of the recurring schedule. BullMQ keys the schedule by this id, so re-registering with
// the same id REPLACES the existing schedule rather than adding a second one, which is what makes
// it safe to call on every worker boot, and what stops a redeploy from doubling the run rate.
export const PAYMENT_EXPIRY_SCHEDULER_ID = "payment-expiry-hourly";

// HOURLY, not daily, and the difference is the candidate's experience rather than the platform's.
// A deadline is shown to the payer as a specific moment; a daily sweep would leave a registration
// visibly past its deadline for up to twenty-four hours, still blocking the candidate from
// re-registering and still holding the organiser's unpublish block open. An hour is close enough
// that the state a candidate sees matches the deadline they were given.
//
// The sweep is idempotent (the expiry event's key is deterministic per payment and the
// cancellation is a compare-and-set) so running it more often costs a query, never a duplicate.
export const PAYMENT_EXPIRY_CRON = "0 * * * *";
export const PAYMENT_EXPIRY_TIMEZONE = "Asia/Jakarta";

/**
 * Registers (or re-registers) the hourly payment-expiry sweep.
 *
 * Registered from the worker runtime rather than the web app for the same reason the retention
 * sweep is: the web app runs on serverless instances that come and go, so there is no single
 * process there whose startup means "the platform is up".
 *
 * Missed occurrences are deliberately NOT backfilled. A deadline does not move, so an overdue
 * payment stays selectable by the next run. After downtime the following sweep collects
 * everything, and asking BullMQ to replay each missed hour would just re-walk the same rows.
 */
export const registerPaymentExpirySchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    PAYMENT_EXPIRY_SCHEDULER_ID,
    { pattern: PAYMENT_EXPIRY_CRON, tz: PAYMENT_EXPIRY_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.paymentExpirySweep,
      data: { scheduledFor: PAYMENT_EXPIRY_CRON },
      opts: {
        // One attempt. The sweep isolates per-payment failures itself, so a retry would only
        // re-walk the payments that already succeeded. The next hour is the retry.
        attempts: 1,
      },
    },
  );

  logger.info("payment.expiry.schedule_registered", {
    schedulerId: PAYMENT_EXPIRY_SCHEDULER_ID,
    pattern: PAYMENT_EXPIRY_CRON,
    timezone: PAYMENT_EXPIRY_TIMEZONE,
  });
};
