import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/recruiter-verification-rejected");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type RecruiterVerificationRejectedPayload,
} from "@/server/async/contracts";
import { sendRecruiterVerificationRejectedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RecruiterVerificationRejectedJob = Job<
  RecruiterVerificationRejectedPayload,
  void,
  typeof ASYNC_JOB_NAMES.recruiterVerificationRejected
>;

// Notifies a recruiter that their trust submission was rejected. Unlike the competition workers,
// this one does NOT re-derive its subject from live state: the recruiter may already have reopened
// the submission by the time the job runs, and re-reading the row would then describe the new
// pending attempt instead of the verdict being announced. The reason and reopen decision travel on
// the payload for exactly that reason. Only the recipient's address is looked up.
export const processRecruiterVerificationRejectedJob = async (
  job: RecruiterVerificationRejectedJob,
): Promise<void> => {
  const { userId, rejectionReason, resubmissionAllowed } = job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "recruiter.verification.rejected",
      reason: "user_not_found",
      jobId: job.id,
      userId,
    });
    return;
  }

  const nextStep = resubmissionAllowed
    ? "Perbarui data dan dokumen Anda, lalu ajukan ulang."
    : "Akun Anda tidak dapat mengirim permohonan baru.";

  // Dual-channel (DEC-0076): in-app row written FIRST, isolated/swallowed; the email block keeps
  // its rethrow-for-retry semantics so the row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.recruiterVerificationRejected,
      title: "Permohonan Rekruter Terpercaya ditolak",
      body: `Alasan: ${rejectionReason} ${nextStep}`,
    },
    { event: "recruiter.verification.rejected", jobId: job.id ?? undefined },
  );

  try {
    await sendRecruiterVerificationRejectedEmail({
      toEmail: user.email,
      recipientId: userId,
      rejectionReason,
      resubmissionAllowed,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "recruiter.verification.rejected",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
