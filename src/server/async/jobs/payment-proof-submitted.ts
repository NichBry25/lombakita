import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/payment-proof-submitted");

import { inArray } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type PaymentProofSubmittedPayload } from "@/server/async/contracts";
import { listInstitutionAdminUserIds } from "@/server/institution-members/member-service";
import { sendPaymentProofSubmittedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import { formatRupiah } from "@/lib/finance/payment-display";

export type PaymentProofSubmittedJob = Job<
  PaymentProofSubmittedPayload,
  void,
  typeof ASYNC_JOB_NAMES.paymentProofSubmitted
>;

/**
 * Tells the organiser a bukti transfer is waiting for them.
 *
 * ORGANISER-ONLY (R13). The payer just pressed the button; telling them they pressed it is noise,
 * and the panel already shows "Menunggu verifikasi". The people who need to know are the ones who
 * can act, which is why recipients come from `listInstitutionAdminUserIds`, the same set the
 * review gate admits, rather than from a list carried on the payload. Resolving at delivery also
 * means a staff member added between submission and dispatch is included.
 */
export const processPaymentProofSubmittedJob = async (
  job: PaymentProofSubmittedJob,
): Promise<void> => {
  const { proofId, competitionTitle, institutionId, payerDisplayName } = job.data;

  const db = getDb();
  const recipientIds = await listInstitutionAdminUserIds(institutionId, db);

  if (recipientIds.length === 0) {
    // A real state, not a bug: an institution whose last admin membership was revoked. Logged
    // rather than thrown, because retrying cannot conjure a recipient.
    logger.warn("notification.skipped", {
      event: "payment.proof.submitted",
      reason: "no_active_admins",
      jobId: job.id,
      institutionId,
    });
    return;
  }

  const recipients = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, recipientIds));

  const amount = formatRupiah(job.data.grossAmount, job.data.currency);
  const title = `Bukti transfer baru untuk ${competitionTitle}`;
  const body = `${payerDisplayName} mengirim bukti transfer sebesar ${amount}. Tinjau dan beri keputusan.`;

  for (const recipient of recipients) {
    await writeInboxNotificationSafely(
      db,
      {
        userId: recipient.id,
        type: NOTIFICATION_TYPES.paymentProofSubmitted,
        title,
        body,
      },
      { event: "payment.proof.submitted", jobId: job.id ?? undefined },
    );
  }

  // Email failures throw so BullMQ retries. The inbox rows above are written first and written
  // safely, so a retry re-sends mail without duplicating inbox entries the recipient has read.
  for (const recipient of recipients) {
    try {
      await sendPaymentProofSubmittedEmail({
        toEmail: recipient.email,
        recipientId: recipient.id,
        competitionTitle,
        institutionSlug: job.data.institutionSlug,
        competitionSlug: job.data.competitionSlug,
        payerDisplayName,
        amount,
      });
    } catch (error) {
      logger.error("notification.failed", {
        event: "payment.proof.submitted",
        jobId: job.id,
        recipientId: recipient.id,
        proofId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
};
