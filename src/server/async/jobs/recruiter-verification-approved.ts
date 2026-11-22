import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/recruiter-verification-approved");

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  ASYNC_JOB_NAMES,
  type RecruiterVerificationApprovedPayload,
} from "@/server/async/contracts";
import { sendRecruiterVerificationApprovedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type RecruiterVerificationApprovedJob = Job<
  RecruiterVerificationApprovedPayload,
  void,
  typeof ASYNC_JOB_NAMES.recruiterVerificationApproved
>;

const findNewestDraftOf = async (db: Database, userId: string) => {
  const [draft] = await db
    .select({
      title: competitions.title,
      slug: competitions.slug,
      institutionSlug: institutions.slug,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.createdByUserId, userId),
        eq(competitions.status, "draft"),
        isNull(competitions.deletedAt),
      ),
    )
    .orderBy(desc(competitions.createdAt))
    .limit(1);

  return draft ?? null;
};

// Tells a host their account may now publish. The newest draft is read when the job runs, so the
// email points at what the host has at that moment.
export const processRecruiterVerificationApprovedJob = async (
  job: RecruiterVerificationApprovedJob,
): Promise<void> => {
  const { userId } = job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "recruiter.verification.approved",
      reason: "user_not_found",
      jobId: job.id,
      userId,
    });
    return;
  }

  const newestDraft = await findNewestDraftOf(db, userId);
  const draft = newestDraft
    ? {
        title: newestDraft.title,
        path: `/institution/${encodeURIComponent(newestDraft.institutionSlug)}/competitions/${encodeURIComponent(newestDraft.slug)}`,
      }
    : null;

  const body = draft
    ? `Anda sekarang dapat menerbitkan kompetisi. Buka draf "${draft.title}" lalu tekan Terbitkan.`
    : "Anda sekarang dapat menerbitkan kompetisi dari dasbor penyelenggara.";

  // Dual-channel (DEC-0076): in-app row written FIRST, isolated/swallowed; the email block keeps
  // its rethrow-for-retry semantics so the row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    {
      userId,
      type: NOTIFICATION_TYPES.recruiterVerificationApproved,
      title: "Anda kini penyelenggara terverifikasi",
      body,
    },
    { event: "recruiter.verification.approved", jobId: job.id ?? undefined },
  );

  try {
    await sendRecruiterVerificationApprovedEmail({
      toEmail: user.email,
      recipientId: userId,
      draft,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "recruiter.verification.approved",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
