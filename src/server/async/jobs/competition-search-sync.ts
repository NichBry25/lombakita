import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/competition-search-sync");

import { and, eq, isNull } from "drizzle-orm";
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
    .select({
      id: competitions.id,
      title: competitions.title,
      slug: competitions.slug,
      category: competitions.category,
      mode: competitions.mode,
      registrationEndAt: competitions.registrationEndAt,
      createdAt: competitions.createdAt,
      isFeatured: competitions.isFeatured,
      featuredOrder: competitions.featuredOrder,
      institutionSlug: institutions.slug,
      institutionName: institutions.displayName,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitions.id, competitionId),
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    category: row.category ?? null,
    mode: row.mode ?? null,
    deadline: row.registrationEndAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isFeatured: row.isFeatured,
    featuredOrder: row.featuredOrder ?? null,
    institutionSlug: row.institutionSlug,
    institutionName: row.institutionName,
    status: "published",
  };
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

    if (action === "remove") {
      await index.deleteDocument(competitionId);
      logger.info("competition-search-sync.removed", { competitionId });
      return;
    }

    // action === "upsert" — load and verify the competition is still published.
    // The competition may have been unpublished between enqueue and job execution.
    const document = await loadPublishedCompetitionForIndex(competitionId);
    if (!document) {
      // No longer published — remove from index defensively.
      await index.deleteDocument(competitionId);
      logger.info("competition-search-sync.removed-not-published", { competitionId });
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
