import { inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { competitions } from "@/server/db/schema";
import { type OperatorActorTransaction } from "@/server/platform-ops/operator-actor";

// Every competition of the institutions, whatever its status or deletion. Each search document
// carries its institution's name and slug, so a change to either has to reach every one of them.
export const readCompetitionIdsOf = async (
  tx: OperatorActorTransaction,
  institutionIds: readonly string[],
): Promise<string[]> => {
  if (institutionIds.length === 0) {
    return [];
  }

  const rows = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(inArray(competitions.institutionId, [...institutionIds]));

  return rows.map((row) => row.id);
};

// After the commit and never awaited, as every search sync is: the job rewrites each document from
// its row and removes the document of an unpublished one. A queue that is down costs a stale
// document, never the write that came before it.
export const enqueueSearchSyncForCompetitions = (competitionIds: readonly string[]): void => {
  for (const competitionId of competitionIds) {
    enqueueCompetitionSearchSync({ competitionId, action: "upsert" }).catch((error: unknown) => {
      logger.error("competition.search-sync.enqueue-failed", {
        competitionId,
        action: "upsert",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
};
