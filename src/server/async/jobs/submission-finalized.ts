import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/submission-finalized");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, competitionSubmissions, userProfiles, users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type SubmissionFinalizedPayload } from "@/server/async/contracts";
import { sendSubmissionFinalizedEmail } from "@/server/notifications/notification-email";

export type SubmissionFinalizedJob = Job<
  SubmissionFinalizedPayload,
  void,
  typeof ASYNC_JOB_NAMES.submissionFinalized
>;

export const processSubmissionFinalizedJob = async (
  job: SubmissionFinalizedJob,
): Promise<void> => {
  const { submissionId, studentId, competitionId } = job.data;

  const db = getDb();

  const [[user], [competition], [submission]] = await Promise.all([
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
    db
      .select({ finalizedAt: competitionSubmissions.finalizedAt })
      .from(competitionSubmissions)
      .where(eq(competitionSubmissions.id, submissionId))
      .limit(1),
  ]);

  if (!user) {
    logger.warn("notification.failed", {
      event: "submission.finalized",
      reason: "user_not_found",
      jobId: job.id,
      studentId,
    });
    return;
  }

  if (!competition) {
    logger.warn("notification.failed", {
      event: "submission.finalized",
      reason: "competition_not_found",
      jobId: job.id,
      competitionId,
    });
    return;
  }

  const finalizedAt = submission?.finalizedAt ?? new Date();

  try {
    await sendSubmissionFinalizedEmail({
      toEmail: user.email,
      recipientId: studentId,
      competitionTitle: competition.title,
      finalizedAt,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "submission.finalized",
      jobId: job.id,
      recipientId: studentId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
