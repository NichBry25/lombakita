import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/search/client");

import { MeiliSearch } from "meilisearch";
import { serverEnv } from "@/config/env.server";

declare global {
  var __lombakitaMeili: MeiliSearch | undefined;
}

const requireMeilisearchHost = (): string => {
  if (!serverEnv.meilisearchHost) {
    throw new Error("MEILISEARCH_HOST is not configured");
  }

  return serverEnv.meilisearchHost;
};

const createMeilisearchClient = (): MeiliSearch => {
  return new MeiliSearch({
    host: requireMeilisearchHost(),
    apiKey: serverEnv.meilisearchApiKey,
  });
};

export const getMeilisearchClient = (): MeiliSearch => {
  if (!globalThis.__lombakitaMeili) {
    globalThis.__lombakitaMeili = createMeilisearchClient();
  }

  return globalThis.__lombakitaMeili;
};
