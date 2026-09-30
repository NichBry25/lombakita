import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/email-egress-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { getAsyncQueue } from "@/server/async/queue";

// Identity of the recurring schedule. BullMQ keys the schedule by this id, so re-registering with
// the same id REPLACES the existing schedule rather than adding a second one, which is what makes
// it safe to call on every worker boot, and what stops a redeploy from doubling the daily run.
export const EMAIL_EGRESS_SCHEDULER_ID = "email-egress-daily";

// DAILY, which is as often as this question is worth asking. Nothing about the answer changes
// between one send and the next unless the runtime's network or the provider's authorization
// changed, and a check that sent more often would spend the provider's rate limit on the platform
// proving itself rather than on participants' mail. One run a day bounds how long a broken egress
// can go unnoticed to a day, which is the window LAUNCH-D43 was filed over.
export const EMAIL_EGRESS_CRON = "30 4 * * *";
export const EMAIL_EGRESS_TIMEZONE = "Asia/Jakarta";

/**
 * Registers (or re-registers) the daily outbound-email egress probe.
 *
 * Registered from the worker runtime rather than the web app because the worker is the process whose
 * egress this checks: the web app sends the registration verification mail from Vercel, and a
 * schedule living there would report on a different runtime's network than the one every other
 * message leaves through (LAUNCH-D49).
 *
 * Missed occurrences are deliberately NOT backfilled. The probe measures the state of the egress at
 * the moment it runs; replaying yesterday's missed runs would report four sends' worth of history
 * that nobody needs and would spend the rate limit doing it.
 */
export const registerEmailEgressSchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    EMAIL_EGRESS_SCHEDULER_ID,
    { pattern: EMAIL_EGRESS_CRON, tz: EMAIL_EGRESS_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.emailEgressProbe,
      data: { scheduledFor: EMAIL_EGRESS_CRON },
      opts: {
        // Three attempts with an exponential backoff, unlike the two sweeps. Those isolate their
        // own per-row failures and the next scheduled run is their retry; this job's subject is a
        // single send, so a retry is the only thing that separates a provider blip from a
        // permanently refused identity. The delay is a minute because the failure being retried is
        // a network or provider hiccup, and it is bounded at three so the report is not delayed
        // past the point an operator would act on it.
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
      },
    },
  );

  logger.info("email.egress_probe.schedule_registered", {
    schedulerId: EMAIL_EGRESS_SCHEDULER_ID,
    pattern: EMAIL_EGRESS_CRON,
    timezone: EMAIL_EGRESS_TIMEZONE,
  });
};
