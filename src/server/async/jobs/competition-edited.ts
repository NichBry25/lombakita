import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-edited");

import { and, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type CompetitionEditedPayload } from "@/server/async/contracts";
import { sendCompetitionEditedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type CompetitionEditedJob = Job<
  CompetitionEditedPayload,
  void,
  typeof ASYNC_JOB_NAMES.competitionEdited
>;

// Step 6.5.1 — fan-out worker for "competition edited". Resolves every confirmed registration on
// the competition and notifies each participant. Dual-channel (DEC-0076): stub Resend email +
// in-app notification row per recipient. No callers yet — wired in Step 6.5f. Both delivery paths
// are isolated: a failure in either never blocks the other and the worker never rethrows
// (notification.inbox.failed is swallowed; the stub email failure is warn-logged, not retried).
export const processCompetitionEditedJob = async (job: CompetitionEditedJob): Promise<void> => {
  const { competitionId } = job.data;

  const db = getDb();

  const [competition] = await db
    .select({ title: competitions.title })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!competition) {
    logger.warn("notification.failed", {
      event: "competition.edited",
      reason: "competition_not_found",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  const recipients = await db
    .select({ userId: competitionRegistrations.studentId, email: users.email })
    .from(competitionRegistrations)
    .innerJoin(users, eq(users.id, competitionRegistrations.studentId))
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    );

  if (recipients.length === 0) {
    logger.warn("notification.skipped", {
      event: "competition.edited",
      reason: "no_confirmed_recipients",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  for (const recipient of recipients) {
    // In-app notification row written FIRST (isolated/swallowed), so it lands regardless of the
    // stub email outcome.
    await writeInboxNotificationSafely(
      db,
      {
        userId: recipient.userId,
        type: NOTIFICATION_TYPES.competitionEdited,
        title: "Kompetisi Diperbarui",
        body: `"${competition.title}" yang kamu daftarkan baru saja diperbarui oleh penyelenggara.`,
      },
      { event: "competition.edited", jobId: job.id ?? undefined },
    );

    // Stub email dispatch — fire-and-forget, warn on failure (no rethrow). Step 6.5f refines copy.
    try {
      await sendCompetitionEditedEmail({
        toEmail: recipient.email,
        recipientId: recipient.userId,
        competitionTitle: competition.title,
      });
    } catch (error) {
      logger.warn("notification.failed", {
        event: "competition.edited",
        jobId: job.id,
        recipientId: recipient.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
