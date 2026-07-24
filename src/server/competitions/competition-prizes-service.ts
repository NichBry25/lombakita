import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-prizes-service");

import { asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionPrizes } from "@/server/db/schema";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";
import {
  parseCompetitionPrizesInput,
  type CompetitionPrizeInput,
} from "@/server/competitions/competition-prizes-core";

export type CompetitionPrizeRecord = {
  id: string;
  rankLabel: string | null;
  title: string;
  description: string | null;
  cashAmount: string | null;
  isCertificate: boolean;
  sortOrder: number;
};

const selectPrizesByCompetition = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionPrizeRecord[]> =>
  db
    .select({
      id: competitionPrizes.id,
      rankLabel: competitionPrizes.rankLabel,
      title: competitionPrizes.title,
      description: competitionPrizes.description,
      cashAmount: competitionPrizes.cashAmount,
      isCertificate: competitionPrizes.isCertificate,
      sortOrder: competitionPrizes.sortOrder,
    })
    .from(competitionPrizes)
    .where(eq(competitionPrizes.competitionId, competitionId))
    .orderBy(asc(competitionPrizes.sortOrder));

// Owner/staff read for the authoring surface.
export const getCompetitionPrizesForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionPrizeRecord[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  return selectPrizesByCompetition(competition.id, db);
};

// Full replacement of a competition's prize list. sort_order is assigned from array order.
export const setCompetitionPrizesForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionPrizeRecord[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const prizes: CompetitionPrizeInput[] = parseCompetitionPrizesInput(payload);

  await db.transaction(async (tx) => {
    await tx.delete(competitionPrizes).where(eq(competitionPrizes.competitionId, competition.id));
    if (prizes.length > 0) {
      await tx.insert(competitionPrizes).values(
        prizes.map((prize, index) => ({
          competitionId: competition.id,
          sortOrder: index,
          rankLabel: prize.rankLabel,
          title: prize.title,
          description: prize.description,
          cashAmount: prize.cashAmount,
          isCertificate: prize.isCertificate,
        })),
      );
    }
  });

  return selectPrizesByCompetition(competition.id, db);
};
