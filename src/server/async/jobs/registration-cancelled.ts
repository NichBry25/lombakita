import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/registration-cancelled");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, userProfiles, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type RegistrationCancelledPayload } from "@/server/async/contracts";
import { sendRegistrationCancelledEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RegistrationCancelledJob = Job<
  RegistrationCancelledPayload,
  void,
  typeof ASYNC_JOB_NAMES.registrationCancelled
>;

export const processRegistrationCancelledJob = async (
  job: RegistrationCancelledJob,
): Promise<void> => {
  const { studentId, competitionId, registrationType } = job.data;

  const db = getDb();

  const [[user], [competition]] = await Promise.all([
    db
      .select({ email: users.email })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, studentId))
      .limit(1),
    db
      .select({ title: competitions.title })
      .from(competitions)
      .where(eq(competitions.id, competitionId))
      .limit(1),
  ]);

  if (!user) {
    logger.warn("notification.failed", {
      event: "registration.cancelled",
      reason: "user_not_found",
      jobId: job.id,
      studentId,
    });
    return;
  }

  if (!competition) {
    logger.warn("notification.failed", {
      event: "registration.cancelled",
      reason: "competition_not_found",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  // Dual-channel (DEC-0076): in-app notification row written FIRST, isolated/swallowed; the email
  // block below keeps its rethrow-for-retry semantics. In-app row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    {
      userId: studentId,
      type: NOTIFICATION_TYPES.registrationCancelled,
      title: "Pendaftaran Dibatalkan",
      body: `Pendaftaranmu untuk kompetisi "${competition.title}" telah dibatalkan.`,
    },
    { event: "registration.cancelled", jobId: job.id ?? undefined },
  );

  try {
    await sendRegistrationCancelledEmail({
      toEmail: user.email,
      recipientId: studentId,
      competitionTitle: competition.title,
      registrationType,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "registration.cancelled",
      jobId: job.id,
      recipientId: studentId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
