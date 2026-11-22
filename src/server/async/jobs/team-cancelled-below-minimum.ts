import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/team-cancelled-below-minimum");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions, teams, users } from "@/server/db/schema";
import { ASYNC_JOB_NAMES, type TeamCancelledBelowMinimumPayload } from "@/server/async/contracts";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import {
  buildTeamCancelledBelowMinimumNotice,
  buildTeamPagePath,
  sendTeamCloseNoticeEmail,
} from "@/server/teams/team-close-notices";

export type TeamCancelledBelowMinimumJob = Job<
  TeamCancelledBelowMinimumPayload,
  void,
  typeof ASYNC_JOB_NAMES.teamCancelledBelowMinimum
>;

const loadTeamCompetition = async (teamId: string, db: Database) => {
  const [row] = await db
    .select({
      competitionTitle: competitions.title,
      competitionSlug: competitions.slug,
      institutionSlug: institutions.slug,
    })
    .from(teams)
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(eq(teams.id, teamId))
    .limit(1);

  return row ?? null;
};

export const processTeamCancelledBelowMinimumJob = async (
  job: TeamCancelledBelowMinimumJob,
): Promise<void> => {
  const { studentId, teamId, memberCount, minTeamSize } = job.data;

  const db = getDb();

  const [[user], teamCompetition] = await Promise.all([
    db.select({ email: users.email }).from(users).where(eq(users.id, studentId)).limit(1),
    loadTeamCompetition(teamId, db),
  ]);

  if (!user) {
    logger.warn("notification.failed", {
      event: "team.cancelled.below_minimum",
      reason: "user_not_found",
      jobId: job.id,
      studentId,
      teamId,
    });
    return;
  }

  if (!teamCompetition) {
    logger.warn("notification.failed", {
      event: "team.cancelled.below_minimum",
      reason: "team_not_found",
      jobId: job.id,
      studentId,
      teamId,
    });
    return;
  }

  const notice = buildTeamCancelledBelowMinimumNotice({
    competitionTitle: teamCompetition.competitionTitle,
    memberCount,
    minTeamSize,
  });

  await writeInboxNotificationSafely(
    db,
    {
      userId: studentId,
      type: NOTIFICATION_TYPES.teamCancelledBelowMinimum,
      title: notice.title,
      body: notice.body,
    },
    { event: "team.cancelled.below_minimum", jobId: job.id ?? undefined },
  );

  try {
    await sendTeamCloseNoticeEmail({
      kind: "team_cancelled_below_minimum",
      toEmail: user.email,
      recipientId: studentId,
      notice,
      teamPagePath: buildTeamPagePath(
        teamCompetition.institutionSlug,
        teamCompetition.competitionSlug,
      ),
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "team.cancelled.below_minimum",
      jobId: job.id,
      recipientId: studentId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
