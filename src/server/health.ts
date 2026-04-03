import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/health");

import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";
import { getConnectorStatusPayload, type ConnectorStatusPayload } from "@/server/connectors/status";

export type HealthPayload = {
  status: "ok";
  service: string;
  environment: string;
  timestamp: string;
  uptimeSeconds: number;
  connectors: ConnectorStatusPayload;
};

export const buildHealthPayload = async (options?: {
  includeLiveChecks?: boolean;
}): Promise<HealthPayload> => {
  const includeLiveChecks =
    options?.includeLiveChecks && serverEnv.connectorHealthProbeEnabled ? true : false;

  return {
    status: "ok",
    service: publicEnv.appName,
    environment: publicEnv.appEnv,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    connectors: await getConnectorStatusPayload(includeLiveChecks),
  };
};
