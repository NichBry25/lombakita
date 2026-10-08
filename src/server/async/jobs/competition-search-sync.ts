import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-search-sync");

import { and, eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { competitions, institutions } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { getMeilisearchClient } from "@/server/search/client";
import { isMeilisearchAvailable } from "@/server/search/availability";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "@/server/search/competition-index";
import {
  COMPETITION_INDEX_COLUMNS,
  publishedCompetitionsFilter,
  toCompetitionIndexDocument,
} from "@/server/search/competition-index-documents";
import { ASYNC_JOB_NAMES, type CompetitionSearchSyncPayload } from "@/server/async/contracts";

export type CompetitionSearchSyncJob = Job<
  CompetitionSearchSyncPayload,
  void,
  typeof ASYNC_JOB_NAMES.competitionSearchSync
>;

const loadPublishedCompetitionForIndex = async (
  competitionId: string,
): Promise<CompetitionIndexDocument | null> => {
  const db = getDb();
  const [row] = await db
    .select(COMPETITION_INDEX_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(and(eq(competitions.id, competitionId), publishedCompetitionsFilter()))
    .limit(1);

  if (!row) return null;

  // The document carries the institution name resolved at sync time; a later username change
  // re-stales it until the competition is re-synced (parallels existing index staleness — see
  // 6.5f.1-Amendment-D1 debt).
  return toCompetitionIndexDocument(row);
};

export const processCompetitionSearchSyncJob = async (
  job: CompetitionSearchSyncJob,
): Promise<void> => {
  const { competitionId, action } = job.data;

  if (!isMeilisearchAvailable()) {
    logger.warn("competition-search-sync.skipped", {
      reason: "meilisearch_unavailable",
      competitionId,
      action,
    });
    return;
  }

  try {
    const client = getMeilisearchClient();
    const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

    const document = await loadPublishedCompetitionForIndex(competitionId);
    if (!document) {
      await index.deleteDocument(competitionId);
      const event =
        action === "remove"
          ? "competition-search-sync.removed"
          : "competition-search-sync.removed-not-published";
      logger.info(event, { competitionId });
      return;
    }

    await index.addDocuments([document], { primaryKey: "id" });
    logger.info("competition-search-sync.upserted", { competitionId });
  } catch (error) {
    logger.error("competition-search-sync.error", {
      competitionId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Let BullMQ retry per ASYNC_JOB_DEFAULT_OPTIONS (3 attempts, exponential backoff)
  }
};
