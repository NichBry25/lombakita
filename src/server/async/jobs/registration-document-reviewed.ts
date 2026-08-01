import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/registration-document-reviewed");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type RegistrationDocumentReviewedPayload,
} from "@/server/async/contracts";
import { sendRegistrationDocumentReviewedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RegistrationDocumentReviewedJob = Job<
  RegistrationDocumentReviewedPayload,
  void,
  typeof ASYNC_JOB_NAMES.registrationDocumentReviewed
>;

// Announces the verdict on a requested document. The verdict and its reason travel on the payload
// rather than being re-read: a rejection that reopens the request leaves the row back in
// `requested`, so the row no longer describes the decision this notification is about.
export const processRegistrationDocumentReviewedJob = async (
  job: RegistrationDocumentReviewedJob,
): Promise<void> => {
  const { requestId, userId, competitionTitle, title, outcome, reviewNote, dueAtIso } = job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "registration.document.reviewed",
      reason: "user_not_found",
      jobId: job.id,
      userId,
      requestId,
    });
    return;
  }

  const inboxTitle =
    outcome === "accepted"
      ? `Dokumen diterima untuk ${competitionTitle}`
      : outcome === "revision_requested"
        ? `Dokumen perlu diunggah ulang untuk ${competitionTitle}`
        : `Dokumen ditolak untuk ${competitionTitle}`;

  const inboxBody =
    outcome === "accepted"
      ? `Dokumen "${title}" Anda telah diterima.`
      : `Dokumen "${title}" belum diterima.${reviewNote ? ` Alasan: ${reviewNote}` : ""}${
          outcome === "revision_requested" ? " Anda dapat mengunggah ulang." : ""
        }`;

  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.registrationDocumentReviewed,
      title: inboxTitle,
      body: inboxBody,
    },
    { event: "registration.document.reviewed", jobId: job.id ?? undefined },
  );

  try {
    await sendRegistrationDocumentReviewedEmail({
      toEmail: user.email,
      recipientId: userId,
      competitionTitle,
      title,
      outcome,
      reviewNote,
      dueAtIso,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "registration.document.reviewed",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
