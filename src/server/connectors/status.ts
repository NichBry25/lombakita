import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/connectors/status");

import { runConnectorProbe, type ConnectorReadiness } from "@/server/connectors/shared";
import { isDatabaseConfigured, probeDatabase } from "@/server/db/probe";
import { isRedisConfigured, probeRedis } from "@/server/redis/probe";
import { isMeilisearchConfigured, probeMeilisearch } from "@/server/search/probe";
import { isR2Configured, probeR2 } from "@/server/storage/probe";

export type ConnectorStatusPayload = {
  connectors: ConnectorReadiness[];
  summary: {
    configured: number;
    liveUp: number;
    liveDown: number;
  };
};

export const getConnectorStatusPayload = async (
  includeLiveChecks: boolean,
): Promise<ConnectorStatusPayload> => {
  const connectors = await Promise.all([
    runConnectorProbe({
      name: "postgres",
      configured: isDatabaseConfigured(),
      includeLiveChecks,
      probe: probeDatabase,
    }),
    runConnectorProbe({
      name: "redis",
      configured: isRedisConfigured(),
      includeLiveChecks,
      probe: probeRedis,
    }),
    runConnectorProbe({
      name: "meilisearch",
      configured: isMeilisearchConfigured(),
      includeLiveChecks,
      probe: probeMeilisearch,
    }),
    runConnectorProbe({
      name: "r2",
      configured: isR2Configured(),
      includeLiveChecks,
      probe: probeR2,
    }),
  ]);

  const summary = {
    configured: connectors.filter((item) => item.configured).length,
    liveUp: connectors.filter((item) => item.live === "up").length,
    liveDown: connectors.filter((item) => item.live === "down").length,
  };

  return {
    connectors,
    summary,
  };
};
