import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/payment-outcome");

import { inArray } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type PaymentOutcomePayload } from "@/server/async/contracts";
import { resolvePaymentGroupMemberUserIds } from "@/server/finance/paid-registration";
import { resolveMemberUserIdsCancelledByExpiry } from "@/server/finance/payment-expiry-service";
import { sendPaymentOutcomeEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import { asSentence, formatRupiah } from "@/lib/finance/payment-display";

export type PaymentOutcomeJob = Job<
  PaymentOutcomePayload,
  void,
  typeof ASYNC_JOB_NAMES.paymentOutcome
>;

const inboxCopy = (
  outcome: PaymentOutcomePayload["outcome"],
  competitionTitle: string,
  amount: string,
  rejectionReason: string | null,
  resubmissionAllowed: boolean | null,
): { title: string; body: string } => {
  if (outcome === "verified") {
    return {
      title: `Pembayaran diverifikasi untuk ${competitionTitle}`,
      body: `Penyelenggara telah memverifikasi pembayaran sebesar ${amount}. Pendaftaran Anda aktif.`,
    };
  }

  if (outcome === "rejected") {
    return {
      title: `Bukti transfer ditolak untuk ${competitionTitle}`,
      body:
        `Penyelenggara menolak bukti transfer Anda.` +
        (rejectionReason ? ` Alasan: ${asSentence(rejectionReason)}` : "") +
        (resubmissionAllowed === false
          ? " Anda tidak dapat mengirim bukti baru. Hubungi penyelenggara sebelum batas waktu."
          : " Unggah bukti transfer yang baru sebelum batas waktu pembayaran."),
    };
  }

  if (outcome === "voided") {
    // LOMBAKITA IS THE ACTOR HERE, and saying so is the whole job of this arm. An operator voided
    // the proof; the organiser did not reject it. Naming the organiser would send the payer to
    // argue a decision that was never theirs.
    //
    // Resubmission is stated UNCONDITIONALLY because the write path allows it unconditionally: the
    // voided arm of `reopenManualPaymentProof` bypasses the organiser's bar (R9/R20). Hedging the
    // sentence would reintroduce in copy the restriction the code deliberately drops.
    return {
      title: `Bukti transfer dibatalkan untuk ${competitionTitle}`,
      body:
        `Tim Lombakita membatalkan bukti transfer Anda, bukan penyelenggara.` +
        (rejectionReason ? ` Alasan: ${asSentence(rejectionReason)}` : "") +
        " Anda dapat mengirim bukti transfer baru sebelum batas waktu pembayaran.",
    };
  }

  // NO ACTOR. "secara otomatis" and the explicit denial are both load-bearing: a cancellation with
  // no named cause reads as the organiser rejecting them, and this candidate would then appeal to
  // someone who made no decision.
  return {
    title: `Pendaftaran dibatalkan otomatis untuk ${competitionTitle}`,
    body: "Batas waktu pembayaran telah lewat, sehingga pendaftaran Anda dibatalkan secara otomatis. Ini bukan keputusan penyelenggara. Jika Anda sudah melakukan transfer, hubungi penyelenggara.",
  };
};

/**
 * Announces a payment's outcome to the people it decides (R13).
 *
 * A team pays once, anchored on the captain's row. A verdict (verified, rejected or voided) decides
 * whether the whole team is still entered, so it goes to every member of the payment group.
 * Telling the captain alone leaves the other members to discover from the competition page that
 * they are no longer registered. An expiry goes only to the members whose registrations made with
 * the payment carry the expiry's reason, so a teammate who joined after the payment keeps a live
 * registration and is not told otherwise.
 *
 * Recipients are resolved at delivery rather than carried on the payload. An expiry's are read
 * from the rows the expiry sweep cancels by, narrowed to those that carry the expiry's reason.
 */
export const processPaymentOutcomeJob = async (job: PaymentOutcomeJob): Promise<void> => {
  const { paymentId, registrationId, competitionTitle, outcome } = job.data;

  const db = getDb();
  const recipientIds =
    outcome === "expired"
      ? await resolveMemberUserIdsCancelledByExpiry(registrationId, db)
      : await resolvePaymentGroupMemberUserIds(registrationId, db);

  if (recipientIds.length === 0) {
    logger.warn("notification.skipped", {
      event: "payment.outcome",
      reason: "no_group_members",
      jobId: job.id,
      paymentId,
    });
    return;
  }

  const recipients = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, recipientIds));

  const amount = formatRupiah(job.data.grossAmount, job.data.currency);
  const { title, body } = inboxCopy(
    outcome,
    competitionTitle,
    amount,
    job.data.rejectionReason,
    job.data.resubmissionAllowed,
  );

  for (const recipient of recipients) {
    await writeInboxNotificationSafely(
      db,
      { userId: recipient.id, type: NOTIFICATION_TYPES.paymentOutcome, title, body },
      { event: "payment.outcome", jobId: job.id ?? undefined },
    );
  }

  for (const recipient of recipients) {
    try {
      await sendPaymentOutcomeEmail({
        toEmail: recipient.email,
        recipientId: recipient.id,
        competitionTitle,
        outcome,
        rejectionReason: job.data.rejectionReason,
        resubmissionAllowed: job.data.resubmissionAllowed,
        amount,
      });
    } catch (error) {
      logger.error("notification.failed", {
        event: "payment.outcome",
        jobId: job.id,
        recipientId: recipient.id,
        paymentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
};
