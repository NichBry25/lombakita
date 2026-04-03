import { getMeilisearchClient } from "@/server/search/client";

export const isMeilisearchConfigured = (): boolean => {
  return Boolean(process.env.MEILISEARCH_HOST);
};

export const probeMeilisearch = async (): Promise<void> => {
  const client = getMeilisearchClient();
  const health = await client.health();

  if (health.status !== "available") {
    throw new Error(`meilisearch status is ${health.status}`);
  }
};
