import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/retention-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { getAsyncQueue } from "@/server/async/queue";

// Identity of the recurring schedule. BullMQ keys the schedule by this id, so re-registering with
// the same id REPLACES the existing schedule rather than adding a second one — which is what makes
// it safe to call on every worker boot, and what stops a redeploy from doubling the daily run.
export const RETENTION_PURGE_SCHEDULER_ID = "retention-purge-daily";

// 03:00 Asia/Jakarta — deliberately off-peak for an Indonesia-first product. The timezone is
// pinned rather than left to the host so the run does not silently move when the worker is
// deployed to a differently-configured region.
export const RETENTION_PURGE_CRON = "0 3 * * *";
export const RETENTION_PURGE_TIMEZONE = "Asia/Jakarta";

/**
 * Registers (or re-registers) the daily retention sweep.
 *
 * One of the two scheduled jobs in the system. The other is the payment-expiry sweep, and every
 * other job is enqueued by a request. It is registered from the worker runtime rather than from
 * the web app because the web app runs on serverless instances that come and go, so there is no
 * single process there whose startup means "the platform is up".
 *
 * A single run is enough per day, and missing one is harmless: retention windows are measured in
 * months, so the next run collects whatever the last one missed. That is why this deliberately
 * does NOT ask BullMQ to backfill missed occurrences after downtime.
 */
export const registerRetentionPurgeSchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    RETENTION_PURGE_SCHEDULER_ID,
    { pattern: RETENTION_PURGE_CRON, tz: RETENTION_PURGE_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.retentionPurge,
      data: { scheduledFor: RETENTION_PURGE_CRON },
      opts: {
        // One attempt: the job already isolates per-competition failures and logs them, so a
        // retry would only re-walk the competitions that succeeded. Tomorrow's run is the retry.
        attempts: 1,
      },
    },
  );

  logger.info("retention.purge.schedule_registered", {
    schedulerId: RETENTION_PURGE_SCHEDULER_ID,
    pattern: RETENTION_PURGE_CRON,
    timezone: RETENTION_PURGE_TIMEZONE,
  });
};
