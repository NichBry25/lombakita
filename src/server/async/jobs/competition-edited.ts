import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-edited");

import { and, eq, ne } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type CompetitionEditedPayload } from "@/server/async/contracts";
import { sendCompetitionEditedEmail } from "@/server/notifications/notification-email";
import { summarizeChangeCategories } from "@/server/notifications/competition-change-summary";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type CompetitionEditedJob = Job<
  CompetitionEditedPayload,
  void,
  typeof ASYNC_JOB_NAMES.competitionEdited
>;

// Step 6.5f — fan-out worker for "competition edited". Re-derives every non-cancelled registration
// on the competition AT JOB-RUN TIME (never a stale enqueue-site list) and notifies each
// participant. Dual-channel (DEC-0076): in-app notification row written first (isolated/swallowed),
// then Resend email. Both delivery paths are isolated: a failure in either never blocks the other
// and the worker never rethrows. The copy names broad change categories (schedule / fees / rules /
// etc), never the old/new field values — the listing page is the source of truth.
export const processCompetitionEditedJob = async (job: CompetitionEditedJob): Promise<void> => {
  const { competitionId, changedFields } = job.data;

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
        ne(competitionRegistrations.status, "cancelled"),
      ),
    );

  if (recipients.length === 0) {
    logger.warn("notification.skipped", {
      event: "competition.edited",
      reason: "no_active_recipients",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  const categories = summarizeChangeCategories(changedFields ?? []);
  const categoryText = categories.length > 0 ? categories.join(", ") : "detail";

  for (const recipient of recipients) {
    // In-app notification row written FIRST (isolated/swallowed), so it lands regardless of the
    // email outcome.
    await writeInboxNotificationSafely(
      db,
      {
        userId: recipient.userId,
        type: NOTIFICATION_TYPES.competitionEdited,
        title: "Kompetisi diperbarui",
        body: `"${competition.title}" yang kamu daftarkan diperbarui oleh penyelenggara. Bagian yang berubah: ${categoryText}.`,
      },
      { event: "competition.edited", jobId: job.id ?? undefined },
    );

    // Email dispatch — fire-and-forget, warn on failure (no rethrow).
    try {
      await sendCompetitionEditedEmail({
        toEmail: recipient.email,
        recipientId: recipient.userId,
        competitionTitle: competition.title,
        changeCategories: categories,
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
