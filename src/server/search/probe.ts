import { getMeilisearchClient } from "@/server/search/client";
import { COMPETITION_INDEX_NAME } from "@/server/search/competition-index";

export const isMeilisearchConfigured = (): boolean => {
  return Boolean(process.env.MEILISEARCH_HOST);
};

export const probeMeilisearch = async (): Promise<void> => {
  const client = getMeilisearchClient();
  const health = await client.health();

  if (health.status !== "available") {
    throw new Error(`meilisearch status is ${health.status}`);
  }

  // `/health` is unauthenticated: it answers "available" to anyone who can reach the host,
  // whatever key was supplied — which is why this probe reported ok throughout the weeks the
  // preview API key was dead. Running the same query the public listing path runs is what
  // actually proves the credential and the index. A probe that cannot fail on the most likely
  // misconfiguration is not doing its job.
  try {
    await client.index(COMPETITION_INDEX_NAME).search("", { limit: 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";

    throw new Error(
      `meilisearch is reachable but searching the "${COMPETITION_INDEX_NAME}" index failed ` +
        "— check MEILISEARCH_API_KEY and that the index exists " +
        `(create it with scripts/setup-search-index.ts): ${detail}`,
    );
  }
};
