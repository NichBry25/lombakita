import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/saved-deadline-reminder-scheduler");

import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { getAsyncQueue } from "@/server/async/queue";

// Fixed id, so re-registering on every worker boot replaces the schedule instead of adding a
// second daily sweep (and a second email per student).
export const SAVED_DEADLINE_REMINDER_SCHEDULER_ID = "saved-deadline-reminder-daily";

// 09:00 WIB, once a day. Daily rather than hourly is a promise to the student: at most one reminder
// email a day however many saved competitions are closing, arriving in the morning when there is
// still a day to act on it. The sweep's band arithmetic assumes this exact moment; see
// `resolveReminderAnchor` before changing it.
export const SAVED_DEADLINE_REMINDER_CRON = "0 9 * * *";
export const SAVED_DEADLINE_REMINDER_TIMEZONE = "Asia/Jakarta";

/**
 * Registers (or re-registers) the daily saved-deadline reminder sweep.
 *
 * From the worker runtime, like the other sweeps: the web app runs on serverless instances with no
 * single process whose startup means "the platform is up".
 *
 * Missed days are deliberately NOT backfilled. A reminder that arrives a day late says the wrong
 * number of days, and the next band still fires on schedule.
 */
export const registerSavedDeadlineReminderSchedule = async (): Promise<void> => {
  const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);

  await queue.upsertJobScheduler(
    SAVED_DEADLINE_REMINDER_SCHEDULER_ID,
    { pattern: SAVED_DEADLINE_REMINDER_CRON, tz: SAVED_DEADLINE_REMINDER_TIMEZONE },
    {
      name: ASYNC_JOB_NAMES.savedDeadlineReminderSweep,
      data: { scheduledFor: SAVED_DEADLINE_REMINDER_CRON },
      opts: {
        // One attempt. The sweep isolates per-student failures itself, and the per-student jobs
        // carry their own retries for the email.
        attempts: 1,
      },
    },
  );

  logger.info("saved.deadline_reminder.schedule_registered", {
    schedulerId: SAVED_DEADLINE_REMINDER_SCHEDULER_ID,
    pattern: SAVED_DEADLINE_REMINDER_CRON,
    timezone: SAVED_DEADLINE_REMINDER_TIMEZONE,
  });
};
