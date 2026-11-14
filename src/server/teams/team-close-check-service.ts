import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-close-check-service");

import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  teamInvitations,
  teamMemberships,
  teams,
  type CompetitionStatus,
} from "@/server/db/schema";
import { enqueueTeamCancelledBelowMinimum, enqueueTeamJoinReminder } from "@/server/async/enqueue";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { isParticipantCancellationClosedByConfirmation } from "@/lib/competitions/competition-participation";
import {
  isPublishedAndNotCancelledOrDeleted,
  registeredTeamCondition,
} from "@/server/teams/registered-team";
import { revertSubmittedTeamToForming } from "@/server/teams/team-registration-service";
import { JOIN_REMINDER_LEAD_HOURS } from "@/server/teams/team-close-notices";

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const HOUR_MS = 60 * 60 * 1000;

// A sentinel rather than prose, so a report can tell the close check's cancellation from a
// captain's own reason.
export const TEAM_BELOW_MINIMUM_CANCELLATION_REASON = "team_below_minimum_at_close";

// Each piece below goes into a query over teams and competitions: both in its FROM, or teams as the
// update's target with competitions in its FROM.
const activeMemberCount = (): SQL<number> =>
  sql<number>`(select count(*)::int from ${teamMemberships} where ${teamMemberships.teamId} = ${teams.id} and ${teamMemberships.status} = 'active')`;

const teamIsBelowMinimum = (): SQL =>
  sql`${competitions.minTeamSize} is not null and ${activeMemberCount()} < ${competitions.minTeamSize}`;

const teamHasUnansweredInvitation = (): SQL =>
  sql`exists (select 1 from ${teamInvitations} where ${and(
    eq(teamInvitations.teamId, teams.id),
    inArray(teamInvitations.status, ["pending", "pending_claim"]),
  )})`;

const teamHasOpenInvitation = (now: Date): SQL =>
  sql`exists (select 1 from ${teamInvitations} where ${and(
    eq(teamInvitations.teamId, teams.id),
    inArray(teamInvitations.status, ["pending", "pending_claim"]),
    gt(teamInvitations.expiresAt, now),
  )})`;

// A team that registered within the lead before the close gets no reminder. The team's registration
// time is its earliest confirmed registration, so a teammate who joined later does not move it.
const teamRegisteredBeforeReminderWindow = (): SQL =>
  sql`(select min(${competitionRegistrations.registeredAt}) from ${competitionRegistrations} where ${competitionRegistrations.teamId} = ${teams.id} and ${competitionRegistrations.status} = 'confirmed') < ${competitions.registrationEndAt} - ${JOIN_REMINDER_LEAD_HOURS}::int * interval '1 hour'`;

const selectCompetitionsWithCloseWorkDue = async (now: Date, db: Database): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ competitionId: competitions.id, feeAmount: competitions.feeAmount })
    .from(competitions)
    .innerJoin(teams, eq(teams.competitionId, competitions.id))
    .where(
      and(
        lte(competitions.registrationEndAt, now),
        isNull(competitions.deletedAt),
        registeredTeamCondition(),
        or(
          teamHasUnansweredInvitation(),
          and(
            eq(competitions.status, "published"),
            isNull(competitions.cancelledAt),
            isNull(competitions.participationConfirmedAt),
            or(
              isNull(competitions.participantConfirmationAt),
              gt(competitions.participantConfirmationAt, now),
            ),
            teamIsBelowMinimum(),
          ),
        ),
      ),
    );

  // The paid check under the lock decides. This filter only keeps paid competitions out of the
  // hourly lock.
  return rows.filter((row) => !isPaidCompetition(row.feeAmount)).map((row) => row.competitionId);
};

type CompetitionAtClose = {
  status: CompetitionStatus;
  registrationEndAt: Date | null;
  feeAmount: number | null;
  minTeamSize: number | null;
  cancelledAt: Date | null;
  deletedAt: Date | null;
  participationConfirmedAt: Date | null;
  participantConfirmationAt: Date | null;
};

const loadCompetitionAtClose = async (
  tx: DbOrTx,
  competitionId: string,
): Promise<CompetitionAtClose | null> => {
  const [row] = await tx
    .select({
      status: competitions.status,
      registrationEndAt: competitions.registrationEndAt,
      feeAmount: competitions.feeAmount,
      minTeamSize: competitions.minTeamSize,
      cancelledAt: competitions.cancelledAt,
      deletedAt: competitions.deletedAt,
      participationConfirmedAt: competitions.participationConfirmedAt,
      participantConfirmationAt: competitions.participantConfirmationAt,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  return row ?? null;
};

const registrationHasClosed = (competition: CompetitionAtClose, now: Date): boolean =>
  competition.registrationEndAt !== null &&
  competition.registrationEndAt.getTime() <= now.getTime();

// The organiser's confirmed entry count must not change once the organiser confirmed participation,
// nor after the participant confirmation moment, which freezes the count as the captain's cancel does.
// A competition that is cancelled, no longer published or deleted keeps its teams as they are.
const acceptsTeamCancellationAtClose = (competition: CompetitionAtClose, now: Date): boolean =>
  isPublishedAndNotCancelledOrDeleted(competition) &&
  competition.participationConfirmedAt === null &&
  !isParticipantCancellationClosedByConfirmation(competition.participantConfirmationAt, now);

// Every unanswered invite, whatever its stored expiry: none of them can be accepted after the close.
// The status condition makes this a compare-and-set, so a decline or a claim that commits first keeps its own result.
const closeUnansweredInvitationsOfRegisteredTeams = async (
  tx: DbOrTx,
  competitionId: string,
): Promise<number> => {
  const registeredTeamIds = tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.competitionId, competitionId), registeredTeamCondition()));

  const closed = await tx
    .update(teamInvitations)
    .set({ status: "cancelled" })
    .where(
      and(
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
        inArray(teamInvitations.teamId, registeredTeamIds),
      ),
    )
    .returning({ id: teamInvitations.id });

  return closed.length;
};

type RegisteredTeamBelowMinimum = { teamId: string; activeMemberCount: number };

const loadRegisteredTeamsBelowMinimum = async (
  tx: DbOrTx,
  competitionId: string,
): Promise<RegisteredTeamBelowMinimum[]> =>
  tx
    .select({ teamId: teams.id, activeMemberCount: activeMemberCount() })
    .from(teams)
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .where(
      and(eq(teams.competitionId, competitionId), registeredTeamCondition(), teamIsBelowMinimum()),
    );

export type TeamCancelledAtClose = {
  teamId: string;
  memberCount: number;
  minTeamSize: number;
  registrations: Array<{ id: string; studentId: string }>;
};

export type TeamsSettledAtClose = {
  competitionId: string;
  closedInvitationCount: number;
  cancelledTeams: TeamCancelledAtClose[];
};

// Under the participation lock, which registering a team, accepting an invite, moving the close and
// the organiser's decision also take, so the competition and its teams are read as they stand at the
// write. Every decline returns, and a return commits, so each decline stays above the writes it guards.
export const settleTeamsAtRegistrationClose = async (
  competitionId: string,
  now: Date,
  db: Database,
): Promise<TeamsSettledAtClose> =>
  db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);

    const competition = await loadCompetitionAtClose(tx, competitionId);
    const nothingSettled: TeamsSettledAtClose = {
      competitionId,
      closedInvitationCount: 0,
      cancelledTeams: [],
    };
    if (competition === null || !registrationHasClosed(competition, now)) return nothingSettled;

    // Paid team competitions keep today's rule, so the close changes nothing in them.
    if (isPaidCompetition(competition.feeAmount)) return nothingSettled;

    const closedInvitationCount = await closeUnansweredInvitationsOfRegisteredTeams(
      tx,
      competitionId,
    );

    const minTeamSize = competition.minTeamSize;
    if (minTeamSize === null || !acceptsTeamCancellationAtClose(competition, now)) {
      return { ...nothingSettled, closedInvitationCount };
    }

    const shortTeams = await loadRegisteredTeamsBelowMinimum(tx, competitionId);

    const cancelledTeams: TeamCancelledAtClose[] = [];
    for (const team of shortTeams) {
      const reverted = await revertSubmittedTeamToForming(
        tx,
        team.teamId,
        competitionId,
        TEAM_BELOW_MINIMUM_CANCELLATION_REASON,
        now,
      );
      cancelledTeams.push({
        teamId: team.teamId,
        memberCount: team.activeMemberCount,
        minTeamSize,
        registrations: reverted.registrations.map((registration) => ({
          id: registration.id,
          studentId: registration.studentId,
        })),
      });
    }

    return { competitionId, closedInvitationCount, cancelledTeams };
  });

// Called after the competition's transaction has committed, so a notice goes only for a
// cancellation that survived. A failed enqueue loses that notice and is logged.
const enqueueNoticesForTeamsCancelledAtClose = (settled: TeamsSettledAtClose): void => {
  const notices = settled.cancelledTeams.flatMap((team) =>
    team.registrations.map((registration) => ({
      registrationId: registration.id,
      studentId: registration.studentId,
      competitionId: settled.competitionId,
      teamId: team.teamId,
      memberCount: team.memberCount,
      minTeamSize: team.minTeamSize,
    })),
  );

  for (const notice of notices) {
    enqueueTeamCancelledBelowMinimum(notice).catch((error: unknown) => {
      logger.warn("team.cancelled_below_minimum.enqueue_failed", {
        registrationId: notice.registrationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
};

// The submitted teams that may be due: the close is within the lead and someone is missing. The fee
// is checked below, and the marker update decides the rest in its own statement.
const selectTeamsDueForJoinReminder = async (
  now: Date,
  reminderWindowEnd: Date,
  db: Database,
): Promise<Array<{ teamId: string; feeAmount: number | null }>> =>
  db
    .select({ teamId: teams.id, feeAmount: competitions.feeAmount })
    .from(teams)
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .where(
      and(
        eq(teams.status, "submitted"),
        gt(competitions.registrationEndAt, now),
        lte(competitions.registrationEndAt, reminderWindowEnd),
        or(teamHasOpenInvitation(now), teamIsBelowMinimum()),
      ),
    );

// The marker takes the competition's close inside this statement and never a JavaScript copy of it:
// the column keeps microseconds and a Date keeps milliseconds, so a copied close might never match.
// The compare-and-set also makes two runs at once remind once.
// The team's registration, the competition's state and the close sit in this statement, so a competition
// cancelled, a close moved or a team cancelled after the read above is judged as it stands at the write.
export const markJoinReminderForCurrentClose = async (
  teamIds: string[],
  now: Date,
  reminderWindowEnd: Date,
  db: Database,
) =>
  db
    .update(teams)
    .set({ joinReminderCloseAt: sql`${competitions.registrationEndAt}` })
    .from(competitions)
    .where(
      and(
        inArray(teams.id, teamIds),
        eq(teams.competitionId, competitions.id),
        registeredTeamCondition(),
        eq(competitions.status, "published"),
        isNull(competitions.cancelledAt),
        isNull(competitions.deletedAt),
        teamRegisteredBeforeReminderWindow(),
        sql`${teams.joinReminderCloseAt} is distinct from ${competitions.registrationEndAt}`,
        gt(competitions.registrationEndAt, now),
        lte(competitions.registrationEndAt, reminderWindowEnd),
      ),
    )
    .returning({
      teamId: teams.id,
      competitionId: teams.competitionId,
      closesAt: sql<Date>`${teams.joinReminderCloseAt}`.mapWith(teams.joinReminderCloseAt),
      // The exact close the marker now holds, as UTC text with microseconds, so delivery can compare it
      // with the columns in SQL. A Date keeps only milliseconds.
      markedClose: sql<string>`to_char(${teams.joinReminderCloseAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    });

export const remindCaptainsBeforeClose = async (now: Date, db: Database): Promise<number> => {
  const reminderWindowEnd = new Date(now.getTime() + JOIN_REMINDER_LEAD_HOURS * HOUR_MS);
  const dueTeams = await selectTeamsDueForJoinReminder(now, reminderWindowEnd, db);

  // Paid team competitions keep today's rule, so their teams are never reminded.
  const freeTeamIds = dueTeams
    .filter((team) => !isPaidCompetition(team.feeAmount))
    .map((team) => team.teamId);
  if (freeTeamIds.length === 0) return 0;

  const marked = await markJoinReminderForCurrentClose(freeTeamIds, now, reminderWindowEnd, db);

  // The marker is already set, so a failed enqueue loses this reminder. It is logged.
  for (const row of marked) {
    enqueueTeamJoinReminder({
      teamId: row.teamId,
      competitionId: row.competitionId,
      closesAt: row.closesAt,
      markedClose: row.markedClose,
    }).catch((error: unknown) => {
      logger.warn("team.join_reminder.enqueue_failed", {
        teamId: row.teamId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return marked.length;
};

export type TeamCloseCheckResult = {
  competitionsExamined: number;
  competitionsFailed: number;
  invitationsClosed: number;
  teamsCancelled: number;
  remindersMarked: number;
};

// One transaction per competition, never one over all: a competition that fails must not roll back
// the others, and the next hourly run selects it again while its work remains.
export const runTeamCloseCheck = async (
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<TeamCloseCheckResult> => {
  const competitionIds = await selectCompetitionsWithCloseWorkDue(now, db);

  let competitionsFailed = 0;
  let invitationsClosed = 0;
  let teamsCancelled = 0;
  for (const competitionId of competitionIds) {
    try {
      const settled = await settleTeamsAtRegistrationClose(competitionId, now, db);
      invitationsClosed += settled.closedInvitationCount;
      teamsCancelled += settled.cancelledTeams.length;
      enqueueNoticesForTeamsCancelledAtClose(settled);
    } catch (error) {
      competitionsFailed += 1;
      logger.warn("team.close_check.competition_failed", {
        competitionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remindersMarked = await remindCaptainsBeforeClose(now, db);

  const result: TeamCloseCheckResult = {
    competitionsExamined: competitionIds.length,
    competitionsFailed,
    invitationsClosed,
    teamsCancelled,
    remindersMarked,
  };
  logger.info("team.close_check.completed", result);

  return result;
};
