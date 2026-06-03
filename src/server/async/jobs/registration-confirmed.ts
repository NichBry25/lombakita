import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/registration-confirmed");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionRegistrations, userProfiles, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type RegistrationConfirmedPayload } from "@/server/async/contracts";
import { sendRegistrationConfirmedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RegistrationConfirmedJob = Job<
  RegistrationConfirmedPayload,
  void,
  typeof ASYNC_JOB_NAMES.registrationConfirmed
>;

export const processRegistrationConfirmedJob = async (
  job: RegistrationConfirmedJob,
): Promise<void> => {
  const { registrationId, studentId, competitionId, registrationType } = job.data;

  const db = getDb();

  const [[user], [competition], registration] = await Promise.all([
    db
      .select({ email: users.email, displayName: userProfiles.displayName })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, studentId))
      .limit(1),
    db
      .select({ title: competitions.title })
      .from(competitions)
      .where(eq(competitions.id, competitionId))
      .limit(1),
    db
      .select({ registeredAt: competitionRegistrations.registeredAt })
      .from(competitionRegistrations)
      .where(eq(competitionRegistrations.id, registrationId))
      .limit(1),
  ]);

  if (!user) {
    logger.warn("notification.failed", {
      event: "registration.confirmed",
      reason: "user_not_found",
      jobId: job.id,
      studentId,
    });
    return;
  }

  if (!competition) {
    logger.warn("notification.failed", {
      event: "registration.confirmed",
      reason: "competition_not_found",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  const registeredAt = registration?.[0]?.registeredAt ?? new Date();

  // Dual-channel (DEC-0076): write the in-app notification row FIRST, in its own isolated
  // try/catch (the helper swallows failure, warns notification.inbox.failed, never rethrows).
  // Writing before the email dispatch guarantees the in-app row lands regardless of the email
  // outcome; the email block below keeps its rethrow-for-BullMQ-retry semantics unchanged.
  await writeInboxNotificationSafely(
    db,
    {
      userId: studentId,
      type: NOTIFICATION_TYPES.registrationConfirmed,
      title: "Pendaftaran Dikonfirmasi",
      body: `Pendaftaranmu untuk kompetisi "${competition.title}" telah dikonfirmasi.`,
    },
    { event: "registration.confirmed", jobId: job.id ?? undefined },
  );

  try {
    await sendRegistrationConfirmedEmail({
      toEmail: user.email,
      recipientId: studentId,
      competitionTitle: competition.title,
      registrationType,
      registeredAt,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "registration.confirmed",
      jobId: job.id,
      recipientId: studentId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
