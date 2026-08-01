import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/registration-document-requested");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type RegistrationDocumentRequestedPayload,
} from "@/server/async/contracts";
import { sendRegistrationDocumentRequestedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RegistrationDocumentRequestedJob = Job<
  RegistrationDocumentRequestedPayload,
  void,
  typeof ASYNC_JOB_NAMES.registrationDocumentRequested
>;

// Tells a participant an organizer has asked them for a document.
//
// Like the recruiter rejection worker, this does NOT re-read the request row. By the time the job
// runs the candidate may have uploaded, or the organizer may have extended the deadline or
// withdrawn the ask entirely — re-reading would announce whatever is true now instead of the event
// being reported. Only the recipient's address is looked up.
export const processRegistrationDocumentRequestedJob = async (
  job: RegistrationDocumentRequestedJob,
): Promise<void> => {
  const { requestId, userId, competitionTitle, institutionName, title, instructions, dueAtIso } =
    job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "registration.document.requested",
      reason: "user_not_found",
      jobId: job.id,
      userId,
      requestId,
    });
    return;
  }

  const dueLabel = new Date(dueAtIso).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Dual-channel: the in-app row is written first and its failure is swallowed, so the email keeps
  // its own rethrow-for-retry semantics.
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.registrationDocumentRequested,
      title: `Dokumen diminta untuk ${competitionTitle}`,
      body: `${institutionName} meminta "${title}" paling lambat ${dueLabel}. Pendaftaran Anda tetap aktif.`,
    },
    { event: "registration.document.requested", jobId: job.id ?? undefined },
  );

  try {
    await sendRegistrationDocumentRequestedEmail({
      toEmail: user.email,
      recipientId: userId,
      competitionTitle,
      institutionName,
      title,
      instructions,
      dueAtIso,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "registration.document.requested",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
