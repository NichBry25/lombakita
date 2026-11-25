import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-tags-service");

import { asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionTags } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  assertPublicFieldsUnchangedByRemovedHost,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { parseCompetitionTagsInput } from "@/server/competitions/competition-tags-core";

const selectTagsByCompetition = async (competitionId: string, db: Database): Promise<string[]> => {
  const rows = await db
    .select({ tag: competitionTags.tag })
    .from(competitionTags)
    .where(eq(competitionTags.competitionId, competitionId))
    .orderBy(asc(competitionTags.tag));
  return rows.map((row) => row.tag);
};

// The tags are public listing text on a live competition, so a host whose trust staff removed keeps
// them as they are there. A save that resends the stored set goes through.
const assertTagsUnchangedByRemovedHost = async (
  actorUserId: string,
  competition: CompetitionRow,
  tags: string[],
  db: Database,
): Promise<void> => {
  if (competition.status !== "published") return;
  const storedTags = await selectTagsByCompetition(competition.id, db);
  const storedKey = JSON.stringify([...storedTags].sort());
  const nextKey = JSON.stringify([...tags].sort());
  const changedFields = storedKey === nextKey ? [] : ["tags"];
  await assertPublicFieldsUnchangedByRemovedHost(actorUserId, changedFields, db);
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
  await assertTagsUnchangedByRemovedHost(actorUserId, competition, tags, db);

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
