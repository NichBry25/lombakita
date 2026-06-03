import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/result-published");

import { and, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, competitionResults, userProfiles, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type ResultPublishedPayload } from "@/server/async/contracts";
import { sendResultPublishedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type ResultPublishedJob = Job<
  ResultPublishedPayload,
  void,
  typeof ASYNC_JOB_NAMES.resultPublished
>;

type RecipientRow = {
  userId: string;
  email: string;
  displayName: string | null;
};

// Load all recipients for this result publish event.
// Individual: one recipient from registrationId.
// Team: all confirmed team member registrations under (competitionId, teamId).
const loadRecipients = async (
  registrationId: string,
  competitionId: string,
  teamId: string | undefined,
): Promise<RecipientRow[]> => {
  const db = getDb();

  if (teamId) {
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: userProfiles.displayName,
      })
      .from(competitionRegistrations)
      .innerJoin(users, eq(users.id, competitionRegistrations.studentId))
      .leftJoin(userProfiles, eq(userProfiles.userId, competitionRegistrations.studentId))
      .where(
        and(
          eq(competitionRegistrations.teamId, teamId),
          eq(competitionRegistrations.competitionId, competitionId),
          eq(competitionRegistrations.status, "confirmed"),
        ),
      );
    return rows;
  }

  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: userProfiles.displayName,
    })
    .from(competitionRegistrations)
    .innerJoin(users, eq(users.id, competitionRegistrations.studentId))
    .leftJoin(userProfiles, eq(userProfiles.userId, competitionRegistrations.studentId))
    .where(eq(competitionRegistrations.id, registrationId))
    .limit(1);

  return row ? [row] : [];
};

export const processResultPublishedJob = async (job: ResultPublishedJob): Promise<void> => {
  const { registrationId, competitionId, teamId } = job.data;

  const db = getDb();
  const [competition] = await db
    .select({ title: competitions.title })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!competition) {
    logger.warn("result.published.competition_not_found", { jobId: job.id, competitionId });
    return;
  }

  // Verify at least one published result row exists for the given registrationId
  // before dispatching — guards against a publish being immediately unpublished.
  const [result] = await db
    .select({ id: competitionResults.id })
    .from(competitionResults)
    .where(
      and(
        eq(competitionResults.registrationId, registrationId),
        eq(competitionResults.resultStatus, "published"),
      ),
    )
    .limit(1);

  if (!result) {
    logger.warn("result.published.no_published_result", { jobId: job.id, registrationId });
    return;
  }

  const recipients = await loadRecipients(registrationId, competitionId, teamId);

  if (recipients.length === 0) {
    logger.warn("result.published.no_recipients", { jobId: job.id, registrationId, competitionId });
    return;
  }

  const errors: string[] = [];
  for (const recipient of recipients) {
    // Dual-channel (DEC-0076): one in-app notification row per confirmed recipient, written FIRST.
    // Isolated from the per-recipient email attempt below — its failure is swallowed and does not
    // affect the email error accounting or the all-failed BullMQ retry decision. Writing before the
    // email guarantees the in-app row lands regardless of email outcome.
    await writeInboxNotificationSafely(
      db,
      {
        userId: recipient.userId,
        type: NOTIFICATION_TYPES.resultPublished,
        title: "Hasil Diumumkan",
        body: `Hasil kompetisi "${competition.title}" telah diumumkan.`,
      },
      { event: "result.published", jobId: job.id ?? undefined },
    );

    try {
      await sendResultPublishedEmail({
        toEmail: recipient.email,
        recipientId: recipient.userId,
        displayName: recipient.displayName,
        competitionTitle: competition.title,
      });
    } catch (error) {
      errors.push(recipient.userId);
      logger.error("notification.failed", {
        event: "result.published",
        jobId: job.id,
        recipientId: recipient.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (errors.length > 0 && errors.length === recipients.length) {
    throw new Error(`All ${recipients.length} result.published email(s) failed — triggering BullMQ retry`);
  }
};
