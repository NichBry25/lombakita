import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/team-invitation-dispatch");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, teamInvitations, teams, userProfiles } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type TeamInvitationDispatchPayload } from "@/server/async/contracts";
import { sendTeamInvitationEmail } from "@/server/teams/team-email";

export type TeamInvitationDispatchJob = Job<
  TeamInvitationDispatchPayload,
  void,
  typeof ASYNC_JOB_NAMES.teamInvitationDispatch
>;

// Step 6.5e — queued send for a team invitation. Same shape as the institution dispatch worker:
// the email variant is derived from the invitation's current status; the in-app inbox entry is
// already live via target_user_id. Resend failure rethrows for BullMQ retry.
export const processTeamInvitationDispatchJob = async (
  job: TeamInvitationDispatchJob,
): Promise<void> => {
  const { invitationId, rawToken } = job.data;
  const db = getDb();

  const [invitation] = await db
    .select({
      invitedEmail: teamInvitations.invitedEmail,
      invitedByUserId: teamInvitations.invitedByUserId,
      status: teamInvitations.status,
      expiresAt: teamInvitations.expiresAt,
      teamName: teams.name,
      competitionTitle: competitions.title,
    })
    .from(teamInvitations)
    .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .where(eq(teamInvitations.id, invitationId))
    .limit(1);

  if (!invitation) {
    logger.warn("team_invitation.dispatch.skipped", {
      reason: "invitation_not_found",
      jobId: job.id,
      invitationId,
    });
    return;
  }

  if (invitation.status !== "pending" && invitation.status !== "pending_claim") {
    logger.warn("team_invitation.dispatch.skipped", {
      reason: "not_sendable_status",
      status: invitation.status,
      jobId: job.id,
      invitationId,
    });
    return;
  }

  let inviterDisplayName: string | null = null;
  if (invitation.invitedByUserId) {
    const [inviter] = await db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, invitation.invitedByUserId))
      .limit(1);
    inviterDisplayName = inviter?.displayName ?? null;
  }

  const mode = invitation.status === "pending_claim" ? "claim" : "targeted";

  await sendTeamInvitationEmail({
    toEmail: invitation.invitedEmail,
    teamName: invitation.teamName,
    competitionTitle: invitation.competitionTitle,
    inviterDisplayName,
    expiresAt: invitation.expiresAt,
    mode,
    rawToken: mode === "claim" ? rawToken : undefined,
  });
};
