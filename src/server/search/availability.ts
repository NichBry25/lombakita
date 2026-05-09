import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/search/availability");

import { serverEnv } from "@/config/env.server";

// Returns true when MEILISEARCH_HOST is present in the environment.
// Both the public listing API and the competition-search-sync job call this before attempting
// any Meilisearch operation. When false, the listing falls back to a DB query and the sync
// job exits cleanly with a warning — no 500, no crash.
export const isMeilisearchAvailable = (): boolean => {
  const host = serverEnv.meilisearchHost;
  const keySet = Boolean(process.env.MEILISEARCH_API_KEY) ? "SET" : "NOT SET";
  // TODO(debug): remove after diagnosing Vercel env var issue
  console.log("[DEBUG availability] MEILISEARCH_HOST:", host ?? "(empty/unset)", "| MEILISEARCH_API_KEY:", keySet);
  return Boolean(host);
};
