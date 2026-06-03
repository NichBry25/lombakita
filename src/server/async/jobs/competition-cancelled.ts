import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-cancelled");

import { and, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type CompetitionCancelledPayload } from "@/server/async/contracts";
import { sendCompetitionCancelledEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type CompetitionCancelledJob = Job<
  CompetitionCancelledPayload,
  void,
  typeof ASYNC_JOB_NAMES.competitionCancelled
>;

// Step 6.5.1 — fan-out worker for "competition cancelled". Mirrors competition-edited: resolves
// every confirmed registration and notifies each participant via stub Resend email + in-app
// notification row (DEC-0076). No callers yet — wired in Step 6.5f. Both delivery paths isolated;
// the worker never rethrows.
export const processCompetitionCancelledJob = async (
  job: CompetitionCancelledJob,
): Promise<void> => {
  const { competitionId } = job.data;

  const db = getDb();

  const [competition] = await db
    .select({ title: competitions.title })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!competition) {
    logger.warn("notification.failed", {
      event: "competition.cancelled",
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
      event: "competition.cancelled",
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
        type: NOTIFICATION_TYPES.competitionCancelled,
        title: "Kompetisi Dibatalkan",
        body: `"${competition.title}" yang kamu daftarkan telah dibatalkan oleh penyelenggara.`,
      },
      { event: "competition.cancelled", jobId: job.id ?? undefined },
    );

    // Stub email dispatch — fire-and-forget, warn on failure (no rethrow). Step 6.5f refines copy.
    try {
      await sendCompetitionCancelledEmail({
        toEmail: recipient.email,
        recipientId: recipient.userId,
        competitionTitle: competition.title,
      });
    } catch (error) {
      logger.warn("notification.failed", {
        event: "competition.cancelled",
        jobId: job.id,
        recipientId: recipient.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
