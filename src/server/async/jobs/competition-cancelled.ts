import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-cancelled");

import { and, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, institutions, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  getCompetitionCancellationReasonLabel,
  INSUFFICIENT_PARTICIPANTS_REASON,
} from "@/lib/competitions/competition-participation";
import { ASYNC_JOB_NAMES, type CompetitionCancelledPayload } from "@/server/async/contracts";
import { INSTITUTION_CANCELLATION_REASON } from "@/server/competitions/competition-lifecycle";
import { sendCompetitionCancelledEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type CompetitionCancelledJob = Job<
  CompetitionCancelledPayload,
  void,
  typeof ASYNC_JOB_NAMES.competitionCancelled
>;

export const buildCompetitionCancellationRecipientsCondition = (
  competitionId: string,
  cancelledAt: Date,
) =>
  and(
    eq(competitionRegistrations.competitionId, competitionId),
    eq(competitionRegistrations.status, "cancelled"),
    eq(competitionRegistrations.cancellationReason, INSTITUTION_CANCELLATION_REASON),
    eq(competitionRegistrations.cancelledAt, cancelledAt),
  )!;

// Step 6.5f — fan-out worker for "competition cancelled" (institution unpublish-as-cancellation).
// Recipients are re-derived AT JOB-RUN TIME from the exact cancellation batch: institution reason
// plus cancelled_at equal to the persisted timestamp carried as `epoch`. The timestamp predicate is
// essential after unpublish → republish: old cancelled registrations must not receive the later
// cycle's cancellation notice again.
// Dual-channel (DEC-0076): in-app row first (isolated/swallowed), then email; never rethrows.
export const processCompetitionCancelledJob = async (
  job: CompetitionCancelledJob,
): Promise<void> => {
  const { competitionId, epoch } = job.data;

  const db = getDb();

  const [competition] = await db
    .select({
      title: competitions.title,
      slug: competitions.slug,
      institutionSlug: institutions.slug,
      cancelledAt: competitions.cancelledAt,
      cancellationReason: competitions.cancellationReason,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
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

  const cancellationReason =
    competition.cancellationReason === INSUFFICIENT_PARTICIPANTS_REASON
      ? getCompetitionCancellationReasonLabel(competition.cancellationReason)
      : null;
  const publicCompetition =
    competition.cancelledAt && cancellationReason
      ? {
          institutionSlug: competition.institutionSlug,
          competitionSlug: competition.slug,
        }
      : undefined;

  const recipients = await db
    .select({ userId: competitionRegistrations.studentId, email: users.email })
    .from(competitionRegistrations)
    .innerJoin(users, eq(users.id, competitionRegistrations.studentId))
    .where(buildCompetitionCancellationRecipientsCondition(competitionId, new Date(epoch)));

  if (recipients.length === 0) {
    logger.warn("notification.skipped", {
      event: "competition.cancelled",
      reason: "no_institution_cancelled_recipients",
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
        title: "Kompetisi dibatalkan",
        body: cancellationReason
          ? `"${competition.title}" dibatalkan oleh penyelenggara. Alasan: ${cancellationReason}`
          : `"${competition.title}" yang kamu daftarkan telah dibatalkan oleh penyelenggara.`,
      },
      { event: "competition.cancelled", jobId: job.id ?? undefined },
    );

    // Stub email dispatch — fire-and-forget, warn on failure (no rethrow). Step 6.5f refines copy.
    try {
      await sendCompetitionCancelledEmail({
        toEmail: recipient.email,
        recipientId: recipient.userId,
        competitionTitle: competition.title,
        cancellationReason: cancellationReason ?? undefined,
        publicCompetition,
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
