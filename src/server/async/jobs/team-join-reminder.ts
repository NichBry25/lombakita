import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/team-join-reminder");

import { eq, sql } from "drizzle-orm";
import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions, teams, users } from "@/server/db/schema";
import { ASYNC_JOB_NAMES, type TeamJoinReminderPayload } from "@/server/async/contracts";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";
import { getTeamForViewer } from "@/server/teams/team-service";
import { isPublishedAndNotCancelledOrDeleted } from "@/server/teams/registered-team";
import {
  JOIN_REMINDER_LEAD_HOURS,
  buildTeamJoinReminderNotice,
  buildTeamPagePath,
  sendTeamCloseNoticeEmail,
  type TeamShortfall,
} from "@/server/teams/team-close-notices";

const HOUR_MS = 60 * 60 * 1000;

export type TeamJoinReminderJob = Job<
  TeamJoinReminderPayload,
  void,
  typeof ASYNC_JOB_NAMES.teamJoinReminder
>;

const loadReminderRecipient = async (teamId: string, markedClose: string, db: Database) => {
  const [row] = await db
    .select({
      captainId: teams.captainId,
      captainEmail: users.email,
      competitionTitle: competitions.title,
      competitionSlug: competitions.slug,
      institutionSlug: institutions.slug,
      minTeamSize: competitions.minTeamSize,
      registrationEndAt: competitions.registrationEndAt,
      competitionStatus: competitions.status,
      cancelledAt: competitions.cancelledAt,
      deletedAt: competitions.deletedAt,
      queuedCloseIsCurrent: sql<
        boolean | null
      >`${teams.joinReminderCloseAt} = ${markedClose}::timestamptz and ${competitions.registrationEndAt} = ${markedClose}::timestamptz`,
    })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.captainId))
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(eq(teams.id, teamId))
    .limit(1);

  return row ?? null;
};

const shortfallOf = (minTeamSize: number | null, memberCount: number): TeamShortfall | null => {
  if (minTeamSize === null || memberCount >= minTeamSize) return null;

  return { missingMemberCount: minTeamSize - memberCount, minTeamSize };
};

// The check decides that a reminder is due. Its words are read here from the team as it is now, so a
// teammate who joined in between is not named, and a team with nobody missing gets nothing.
export const processTeamJoinReminderJob = async (job: TeamJoinReminderJob): Promise<void> => {
  const { teamId, markedClose } = job.data;

  const db = getDb();
  const deliveredAt = new Date();

  const recipient = await loadReminderRecipient(teamId, markedClose, db);
  if (recipient === null || recipient.registrationEndAt === null) {
    logger.warn("team.join_reminder.skipped", {
      reason: "team_not_found",
      jobId: job.id,
      teamId,
    });
    return;
  }

  // A retry or a slow queue can deliver after the competition stopped taking registrations, and
  // the reminder's words would then be false.
  if (
    !isPublishedAndNotCancelledOrDeleted({
      status: recipient.competitionStatus,
      cancelledAt: recipient.cancelledAt,
      deletedAt: recipient.deletedAt,
    }) ||
    recipient.registrationEndAt.getTime() <= deliveredAt.getTime()
  ) {
    logger.warn("team.join_reminder.skipped", {
      reason: "registration_not_open",
      jobId: job.id,
      teamId,
    });
    return;
  }

  // The check queued this reminder for the close in markedClose. After a move or a later marking,
  // the next hourly run decides on its own, and "24 jam" holds only inside the lead.
  if (
    recipient.queuedCloseIsCurrent !== true ||
    recipient.registrationEndAt.getTime() >
      deliveredAt.getTime() + JOIN_REMINDER_LEAD_HOURS * HOUR_MS
  ) {
    logger.warn("team.join_reminder.skipped", {
      reason: "close_moved",
      jobId: job.id,
      teamId,
    });
    return;
  }

  const snapshot = await getTeamForViewer(recipient.captainId, teamId, db);
  if (snapshot.team.status !== "submitted") {
    logger.warn("team.join_reminder.skipped", {
      reason: "team_not_submitted",
      jobId: job.id,
      teamId,
    });
    return;
  }

  // An invite whose own expiry has passed can no longer be accepted, so the reminder does not name it.
  const openInvitations = snapshot.pendingInvitations.filter(
    (invitation) => invitation.expiresAt.getTime() > deliveredAt.getTime(),
  );
  const pendingInviteeEmails = openInvitations.map((invitation) => invitation.invitedEmail);
  const shortfall = shortfallOf(recipient.minTeamSize, snapshot.roster.length);

  if (pendingInviteeEmails.length === 0 && shortfall === null) {
    logger.warn("team.join_reminder.skipped", {
      reason: "nothing_missing",
      jobId: job.id,
      teamId,
    });
    return;
  }

  const notice = buildTeamJoinReminderNotice({
    competitionTitle: recipient.competitionTitle,
    closesAt: recipient.registrationEndAt,
    pendingInviteeEmails,
    shortfall,
  });

  await writeInboxNotificationSafely(
    db,
    {
      userId: recipient.captainId,
      type: NOTIFICATION_TYPES.teamJoinReminder,
      title: notice.title,
      body: notice.body,
    },
    { event: "team.join.reminder", jobId: job.id ?? undefined },
  );

  try {
    await sendTeamCloseNoticeEmail({
      kind: "team_join_reminder",
      toEmail: recipient.captainEmail,
      recipientId: recipient.captainId,
      notice,
      teamPagePath: buildTeamPagePath(recipient.institutionSlug, recipient.competitionSlug),
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "team.join.reminder",
      jobId: job.id,
      recipientId: recipient.captainId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
