import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/saved-deadline-reminder");

import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type SavedDeadlineReminderPayload } from "@/server/async/contracts";
import { sendSavedDeadlineReminderEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import { buildSavedDeadlineReminderInbox } from "@/server/notifications/saved-deadline-reminder-message";
import {
  findReminderRecipientEmail,
  listDueSavedDeadlineReminders,
} from "@/server/saved-competitions/saved-deadline-reminder-service";

export type SavedDeadlineReminderJob = Job<
  SavedDeadlineReminderPayload,
  void,
  typeof ASYNC_JOB_NAMES.savedDeadlineReminder
>;

/**
 * One student's daily reminder: every saved competition of theirs closing in 7, 3 or 1 days, in one
 * inbox row and one email.
 *
 * The due list is read again here instead of being carried from the sweep. Between the sweep and
 * this job the student may have registered (alone or through a team) or unsaved the competition,
 * and either should silence it. An empty list ends the job quietly.
 */
export const processSavedDeadlineReminderJob = async (
  job: SavedDeadlineReminderJob,
): Promise<void> => {
  const { userId, anchorAt } = job.data;
  const anchor = new Date(anchorAt);
  const db = getDb();

  const toEmail = await findReminderRecipientEmail(userId, db);
  if (!toEmail) {
    logger.warn("notification.failed", {
      event: "saved.deadline.reminder",
      reason: "user_not_found",
      jobId: job.id,
      userId,
    });
    return;
  }

  const due = await listDueSavedDeadlineReminders(anchor, { userId }, db);
  if (due.length === 0) {
    logger.info("saved.deadline_reminder.nothing_due", { jobId: job.id, userId, anchorAt });
    return;
  }

  // Dual-channel (DEC-0076), in the same order as every other notification worker: the inbox row
  // first, in its own swallowed try/catch, then the email, which rethrows so BullMQ retries it.
  const inbox = buildSavedDeadlineReminderInbox(due, anchor);
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.savedDeadlineReminder,
      title: inbox.title,
      body: inbox.body,
    },
    { event: "saved.deadline.reminder", jobId: job.id ?? undefined },
  );

  try {
    await sendSavedDeadlineReminderEmail({ toEmail, recipientId: userId, items: due, anchor });
  } catch (error) {
    logger.error("notification.failed", {
      event: "saved.deadline.reminder",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
