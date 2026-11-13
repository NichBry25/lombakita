import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/registered-team");

// A free team registers once its joined members and open invites reach the minimum, and keeps
// taking invites until registration closes. These reads and writes define that registered team.

import { and, eq, gt, inArray, lte, sql, type SQL } from "drizzle-orm";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import type { Database } from "@/server/db/client";
import { competitionRegistrations, competitions, teamInvitations, teams } from "@/server/db/schema";
import { TeamError } from "@/server/teams/team-core";

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// A team is registered while it is submitted and holds a confirmed registration. The query this
// goes into must have teams in its FROM.
export const registeredTeamCondition = (): SQL =>
  sql`${teams.status} = 'submitted' and exists (select 1 from ${competitionRegistrations} where ${competitionRegistrations.teamId} = ${teams.id} and ${competitionRegistrations.status} = 'confirmed')`;

export type RegisteredFreeTeamLimits = { closesAt: Date; maxTeamSize: number | null };

// The invite and the accept call this under the competition's participation lock, so their
// answer holds until commit. Throws the TeamError a refused request answers with.
export const assertRegisteredFreeTeamOpen = async (
  db: DbOrTx,
  teamId: string,
  now: Date,
): Promise<RegisteredFreeTeamLimits> => {
  const [row] = await db
    .select({
      teamStatus: teams.status,
      competitionStatus: competitions.status,
      cancelledAt: competitions.cancelledAt,
      deletedAt: competitions.deletedAt,
      feeAmount: competitions.feeAmount,
      registrationEndAt: competitions.registrationEndAt,
      maxTeamSize: competitions.maxTeamSize,
      isRegistered: sql<boolean>`${registeredTeamCondition()}`,
    })
    .from(teams)
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .where(eq(teams.id, teamId))
    .limit(1);

  if (!row) {
    throw new TeamError("team_not_found", "Team not found");
  }
  if (row.teamStatus !== "submitted") {
    throw new TeamError("team_state_conflict", "Team state changed. Reload and retry.");
  }
  // A paid team still needs every member joined before it registers, so it takes no change after.
  if (isPaidCompetition(row.feeAmount)) {
    throw new TeamError("team_not_forming", "Team is no longer in forming state");
  }
  if (row.competitionStatus !== "published" || row.cancelledAt !== null || row.deletedAt !== null) {
    throw new TeamError(
      "team_competition_not_published",
      "Competition is not open for team registration",
    );
  }
  // The close is read live, so an invite whose stored expiry is later is still refused.
  if (row.registrationEndAt === null || row.registrationEndAt.getTime() <= now.getTime()) {
    throw new TeamError(
      "team_competition_registration_closed",
      "Registration window for this competition has closed",
    );
  }
  if (!row.isRegistered) {
    throw new TeamError("team_not_forming", "Team has no confirmed registration");
  }

  return { closesAt: row.registrationEndAt, maxTeamSize: row.maxTeamSize };
};

// The way an accept attempt treats an expired invite, so a registered team holds only invites
// that expire at the close.
export const cancelExpiredTeamInvitations = async (
  tx: DbOrTx,
  teamId: string,
  now: Date,
): Promise<void> => {
  await tx
    .update(teamInvitations)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
        lte(teamInvitations.expiresAt, now),
      ),
    );
};

export const extendOpenTeamInvitationsToClose = async (
  tx: DbOrTx,
  teamId: string,
  closesAt: Date,
  now: Date,
): Promise<void> => {
  await tx
    .update(teamInvitations)
    .set({ expiresAt: closesAt })
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
        gt(teamInvitations.expiresAt, now),
      ),
    );
};

// Runs in the transaction that moves the close, so no open invite of a registered team keeps the
// old one.
export const moveRegisteredTeamInvitationsToClose = async (
  tx: DbOrTx,
  competitionId: string,
  closesAt: Date,
): Promise<void> => {
  const registeredTeamIds = tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.competitionId, competitionId), registeredTeamCondition()));

  await tx
    .update(teamInvitations)
    .set({ expiresAt: closesAt })
    .where(
      and(
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
        gt(teamInvitations.expiresAt, sql`now()`),
        inArray(teamInvitations.teamId, registeredTeamIds),
      ),
    );
};
