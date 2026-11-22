import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/saved-deadline-reminder-sweep");

import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type SavedDeadlineReminderSweepPayload } from "@/server/async/contracts";
import { enqueueSavedDeadlineReminder } from "@/server/async/enqueue";
import { sweepSavedDeadlineReminders } from "@/server/saved-competitions/saved-deadline-reminder-service";

export type SavedDeadlineReminderSweepJob = Job<
  SavedDeadlineReminderSweepPayload,
  void,
  typeof ASYNC_JOB_NAMES.savedDeadlineReminderSweep
>;

/**
 * Hands every student with a saved competition closing in 7, 3 or 1 days one reminder job.
 *
 * A THIN WRAPPER, for the same reason as the payment-expiry sweep: which competitions are due, and
 * for whom, is decided in `sweepSavedDeadlineReminders`, where it is testable without a queue. The
 * sweep isolates per-student enqueue failures and reports them, so this does not rethrow; tomorrow's
 * run is the retry for anything that did not go out.
 */
export const processSavedDeadlineReminderSweepJob = async (
  job: SavedDeadlineReminderSweepJob,
): Promise<void> => {
  const result = await sweepSavedDeadlineReminders({ enqueue: enqueueSavedDeadlineReminder });

  logger.info("saved.deadline_reminder.sweep_completed", {
    jobId: job.id,
    anchorAt: result.anchorAt.toISOString(),
    due: result.due,
    students: result.students,
    enqueued: result.enqueued,
    failed: result.failed,
  });
};
