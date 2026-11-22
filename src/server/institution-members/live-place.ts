import { and, eq, exists, gt, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { competitionRegistrations, competitions, teamMemberships, teams } from "@/server/db/schema";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-members/live-place");

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const readInstitutionCompetitionIdsAscending = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<string[]> => {
  const rows = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(eq(competitions.institutionId, institutionId));

  // Sorted in JavaScript, as lockInstitutionOwnership sorts, so every writer that takes several of
  // these locks takes them in one order.
  return rows.map((row) => row.id).sort();
};

/**
 * Takes the participation lock of every competition of the institution, for the life of `tx`, so
 * that a join and a promotion of the same person cannot both pass their checks.
 *
 * Every join reads isCompetitionHost under the participation lock of its competition. A writer that
 * makes someone owner or staff takes the same locks before it reads whether they hold a place, so
 * one of the two sees the other's committed row.
 *
 * Drafts and soft-deleted competitions are included, so a publish cannot add a competition to the
 * set. The set is a predicate over other rows: it is read, locked, and read again, and a set that
 * grew is refused rather than locked late, because a late lock is out of order. Nothing has been
 * written yet when it refuses.
 *
 * Call after lockInstitutionOwnership and never while the transaction holds a users row lock: every
 * join holds a participation lock and then waits on the users row its insert references.
 */
export const lockInstitutionCompetitionsForPlaceCheck = async (
  tx: TransactionClient,
  institutionId: string,
  retryRefusal: () => Error,
): Promise<void> => {
  const lockedIds = await readInstitutionCompetitionIdsAscending(tx, institutionId);

  for (const competitionId of lockedIds) {
    await acquireCompetitionParticipationLock(tx, competitionId);
  }

  const currentIds = await readInstitutionCompetitionIdsAscending(tx, institutionId);
  const lockedSet = new Set(lockedIds);
  const setGrew = currentIds.some((competitionId) => !lockedSet.has(competitionId));

  if (setGrew) {
    throw retryRefusal();
  }
};

const isLiveCompetitionOfInstitution = (institutionId: string, now: Date): SQL | undefined =>
  and(
    eq(competitions.institutionId, institutionId),
    isNull(competitions.deletedAt),
    or(isNull(competitions.eventEndAt), gt(competitions.eventEndAt, now)),
  );

/**
 * Whether the person holds a place in a competition of the institution whose event has not ended.
 *
 * A place is the person's own registration that is not cancelled, or an active membership of a team
 * that has a registration that is not cancelled. The second part is read from the membership and
 * not from a registration row of the person, because a teammate who joined while a paid team
 * registered has no row of their own. Payment state does not matter: an unpaid registration is
 * written as confirmed.
 *
 * Read the clock here, after lockInstitutionCompetitionsForPlaceCheck has returned, the way a join
 * reads its mutation time after its lock.
 */
export const holdsLivePlaceInInstitution = async (
  tx: TransactionClient,
  userId: string,
  institutionId: string,
): Promise<boolean> => {
  const now = new Date();
  const isLive = isLiveCompetitionOfInstitution(institutionId, now);

  const [ownRegistration] = await tx
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(
      and(
        eq(competitionRegistrations.studentId, userId),
        ne(competitionRegistrations.status, "cancelled"),
        isLive,
      ),
    )
    .limit(1);

  if (ownRegistration) {
    return true;
  }

  const teamHasLiveRegistration = exists(
    tx
      .select({ id: competitionRegistrations.id })
      .from(competitionRegistrations)
      .where(
        and(
          eq(competitionRegistrations.teamId, teams.id),
          ne(competitionRegistrations.status, "cancelled"),
        ),
      ),
  );

  const [teamPlace] = await tx
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .innerJoin(competitions, eq(competitions.id, teams.competitionId))
    .where(
      and(
        eq(teamMemberships.userId, userId),
        eq(teamMemberships.status, "active"),
        isLive,
        teamHasLiveRegistration,
      ),
    )
    .limit(1);

  return teamPlace !== undefined;
};
