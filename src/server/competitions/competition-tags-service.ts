import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-tags-service");

import { asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionTags } from "@/server/db/schema";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";
import { parseCompetitionTagsInput } from "@/server/competitions/competition-tags-core";

const selectTagsByCompetition = async (competitionId: string, db: Database): Promise<string[]> => {
  const rows = await db
    .select({ tag: competitionTags.tag })
    .from(competitionTags)
    .where(eq(competitionTags.competitionId, competitionId))
    .orderBy(asc(competitionTags.tag));
  return rows.map((row) => row.tag);
};

export const getCompetitionTagsForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  return selectTagsByCompetition(competition.id, db);
};

// Full replacement of a competition's tag set.
export const setCompetitionTagsForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<string[]> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const tags = parseCompetitionTagsInput(payload);

  await db.transaction(async (tx) => {
    await tx.delete(competitionTags).where(eq(competitionTags.competitionId, competition.id));
    if (tags.length > 0) {
      await tx
        .insert(competitionTags)
        .values(tags.map((tag) => ({ competitionId: competition.id, tag })));
    }
  });

  return selectTagsByCompetition(competition.id, db);
};
