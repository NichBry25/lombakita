import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-prizes-service");

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionPrizes, competitions } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  hasActiveRegistrationsForCompetition,
} from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import {
  parseCompetitionPrizesInput,
  type CompetitionPrizeInput,
} from "@/server/competitions/competition-prizes-core";
import {
  DRAFT_PRIZES_HELD_BY_REGISTRATIONS_REASON,
  PUBLISH_LOCK_REASONS,
} from "@/lib/competitions/publish-locks";

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

export type CompetitionPrizesForEditor = {
  prizes: CompetitionPrizeRecord[];
  locked: boolean;
};

// Owner/staff read for the authoring surface. The prizes are locked once the competition is not a
// draft.
export const getCompetitionPrizesForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionPrizesForEditor> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const prizes = await selectPrizesByCompetition(competition.id, db);
  return { prizes, locked: competition.status !== "draft" };
};

// The only status guard of a prize save. It writes the competitions row only while it is a draft,
// so it takes the row lock that publish's status update waits for: a publish either commits before
// this write, which then matches nothing, or after the save commits.
const assertDraftAndHoldCompetitionRow = async (
  competitionId: string,
  db: Database,
): Promise<void> => {
  const [row] = await db
    .update(competitions)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(competitions.id, competitionId), eq(competitions.status, "draft")))
    .returning({ id: competitions.id });

  if (!row) {
    throw new CompetitionError(
      "competition_prizes_locked_after_publish",
      409,
      PUBLISH_LOCK_REASONS.prizes,
    );
  }
};

// Only legacy drafts reach this: unpublish and the operator cancel both cancel every registration.
const assertNoActiveRegistrations = async (competitionId: string, db: Database): Promise<void> => {
  if (await hasActiveRegistrationsForCompetition(competitionId, db)) {
    throw new CompetitionError(
      "competition_prizes_held_by_registrations",
      409,
      DRAFT_PRIZES_HELD_BY_REGISTRATIONS_REASON,
    );
  }
};

// Full replacement of a draft competition's prize list. sort_order is assigned from array order.
export const setCompetitionPrizesForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionPrizeRecord[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const prizes: CompetitionPrizeInput[] = parseCompetitionPrizesInput(payload);

  await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competition.id);
    await assertDraftAndHoldCompetitionRow(competition.id, tx);
    await assertNoActiveRegistrations(competition.id, tx);
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
