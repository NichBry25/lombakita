import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/team-close-check-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { getAsyncQueue } from "@/server/async/queue";

// Identity of the recurring schedule. BullMQ keys the schedule by this id, so re-registering with
// the same id REPLACES the existing schedule rather than adding a second one, which is what makes
// it safe to call on every worker boot, and what stops a redeploy from doubling the run rate.
export const TEAM_CLOSE_CHECK_SCHEDULER_ID = "team-close-check-hourly";

// Hourly, so a passed close is settled and a due reminder is sent within the hour.
export const TEAM_CLOSE_CHECK_CRON = "0 * * * *";
export const TEAM_CLOSE_CHECK_TIMEZONE = "Asia/Jakarta";

/**
 * Registers (or re-registers) the hourly team close check, from the worker runtime for the reason the
 * payment expiry sweep is. Missed occurrences are not backfilled: a passed close stays selectable while
 * its work remains, so the next run collects it.
 */
export const registerTeamCloseCheckSchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    TEAM_CLOSE_CHECK_SCHEDULER_ID,
    { pattern: TEAM_CLOSE_CHECK_CRON, tz: TEAM_CLOSE_CHECK_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.teamCloseCheck,
      data: { scheduledFor: TEAM_CLOSE_CHECK_CRON },
      opts: {
        // One attempt. The check isolates each competition's failure itself, so the next hour is the retry.
        attempts: 1,
      },
    },
  );

  logger.info("team.close_check.schedule_registered", {
    schedulerId: TEAM_CLOSE_CHECK_SCHEDULER_ID,
    pattern: TEAM_CLOSE_CHECK_CRON,
    timezone: TEAM_CLOSE_CHECK_TIMEZONE,
  });
};
