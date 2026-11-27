import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-rounds-service");

import { asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionRounds } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  assertPublicFieldsUnchangedByRemovedHost,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import {
  parseCompetitionRoundsInput,
  type CompetitionRoundInput,
} from "@/server/competitions/competition-rounds-core";

export type CompetitionRoundRecord = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  platformLabel: string | null;
  sortOrder: number;
};

const selectRoundsByCompetition = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionRoundRecord[]> =>
  db
    .select({
      id: competitionRounds.id,
      title: competitionRounds.title,
      description: competitionRounds.description,
      startsAt: competitionRounds.startsAt,
      endsAt: competitionRounds.endsAt,
      platformLabel: competitionRounds.platformLabel,
      sortOrder: competitionRounds.sortOrder,
    })
    .from(competitionRounds)
    .where(eq(competitionRounds.competitionId, competitionId))
    .orderBy(asc(competitionRounds.sortOrder));

// The parts of a round that the public page shows, in a form that compares by value.
const toComparableRound = (round: CompetitionRoundInput) => ({
  title: round.title,
  description: round.description,
  platformLabel: round.platformLabel,
  startsAt: round.startsAt?.getTime() ?? null,
  endsAt: round.endsAt?.getTime() ?? null,
});

// The rounds are public on a live competition: its page shows each round's title, description,
// platform label and dates, in order. A host whose trust staff removed keeps them as they are there.
// A save that resends the stored rounds in their order goes through.
const assertRoundsUnchangedByRemovedHost = async (
  actorUserId: string,
  competition: CompetitionRow,
  rounds: CompetitionRoundInput[],
  db: Database,
): Promise<void> => {
  if (competition.status !== "published") return;
  const storedRounds = await selectRoundsByCompetition(competition.id, db);
  const storedKey = JSON.stringify(storedRounds.map(toComparableRound));
  const nextKey = JSON.stringify(rounds.map(toComparableRound));
  const changedFields = storedKey === nextKey ? [] : ["rounds"];
  await assertPublicFieldsUnchangedByRemovedHost(actorUserId, changedFields, db);
};

// Owner/staff read for the authoring surface.
export const getCompetitionRoundsForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionRoundRecord[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  return selectRoundsByCompetition(competition.id, db);
};

// Full replacement of a competition's round list. sort_order is assigned from array order.
export const setCompetitionRoundsForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionRoundRecord[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const rounds: CompetitionRoundInput[] = parseCompetitionRoundsInput(payload);
  await assertRoundsUnchangedByRemovedHost(actorUserId, competition, rounds, db);

  await db.transaction(async (tx) => {
    await tx.delete(competitionRounds).where(eq(competitionRounds.competitionId, competition.id));
    if (rounds.length > 0) {
      await tx.insert(competitionRounds).values(
        rounds.map((round, index) => ({
          competitionId: competition.id,
          sortOrder: index,
          title: round.title,
          description: round.description,
          startsAt: round.startsAt,
          endsAt: round.endsAt,
          platformLabel: round.platformLabel,
        })),
      );
    }
  });

  return selectRoundsByCompetition(competition.id, db);
};
