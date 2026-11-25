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
import { competitionGuidelineTextOf } from "@/lib/competitions/competition-guidelines";

export type RecruiterVerificationRejectedJob = Job<
  RecruiterVerificationRejectedPayload,
  void,
  typeof ASYNC_JOB_NAMES.recruiterVerificationRejected
>;

type RejectionNotice = { title: string; body: string };

const buildRequestRejectedNotice = (
  rejectionReason: string,
  resubmissionAllowed: boolean,
): RejectionNotice => {
  const nextStep = resubmissionAllowed
    ? "Perbarui data dan dokumen Anda, lalu ajukan ulang."
    : "Akun Anda tidak dapat mengirim permohonan baru.";
  return {
    title: "Permohonan penyelenggara terverifikasi ditolak",
    body: `Alasan: ${rejectionReason} ${nextStep}`,
  };
};

// A guideline sentence ends with its own full stop. An item the list does not know is shown by its
// code.
const buildHostCheckTurnDownNotice = (guidelineItem: string, note: string): RejectionNotice => {
  const guidelineText = competitionGuidelineTextOf(guidelineItem) ?? guidelineItem;
  return {
    title: "Kompetisi Anda belum dapat tayang",
    body: `Pedoman: ${guidelineText} Catatan staf: ${note} Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.`,
  };
};

// Notifies a host that a request was rejected or a host check turned down. Unlike the competition
// workers, this one does NOT re-derive its subject from live state: the row may change before the
// job runs, so the reason, the reopen choice and the guideline item travel on the payload. Only the
// recipient's address is looked up.
export const processRecruiterVerificationRejectedJob = async (
  job: RecruiterVerificationRejectedJob,
): Promise<void> => {
  const { userId, rejectionReason, resubmissionAllowed, guidelineItem } = job.data;

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

  const notice =
    guidelineItem === undefined
      ? buildRequestRejectedNotice(rejectionReason, resubmissionAllowed)
      : buildHostCheckTurnDownNotice(guidelineItem, rejectionReason);

  // Dual-channel (DEC-0076): in-app row written FIRST, isolated and swallowed. The email block keeps
  // its rethrow-for-retry semantics so the row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.recruiterVerificationRejected,
      title: notice.title,
      body: notice.body,
    },
    { event: "recruiter.verification.rejected", jobId: job.id ?? undefined },
  );

  try {
    await sendRecruiterVerificationRejectedEmail({
      toEmail: user.email,
      recipientId: userId,
      rejectionReason,
      resubmissionAllowed,
      ...(guidelineItem === undefined ? {} : { hostCheckTurnDown: notice }),
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
