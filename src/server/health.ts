import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/health");

import { publicEnv } from "@/config/env";
import { getRuntimeEnvValidation, serverEnv } from "@/config/env.server";
import { getConnectorStatusPayload, type ConnectorStatusPayload } from "@/server/connectors/status";

export type HealthPayload = {
  status: "ok";
  service: string;
  environment: string;
  runtime: string;
  timestamp: string;
  uptimeSeconds: number;
  runtimeContract: {
    requiredKeys: string[];
    missingKeys: string[];
  };
  connectors: ConnectorStatusPayload;
};

export const buildHealthPayload = async (options?: {
  includeLiveChecks?: boolean;
}): Promise<HealthPayload> => {
  const includeLiveChecks =
    options?.includeLiveChecks && serverEnv.connectorHealthProbeEnabled ? true : false;

  const runtimeValidation = getRuntimeEnvValidation("web");

  return {
    status: "ok",
    service: publicEnv.appName,
    environment: publicEnv.appEnv,
    runtime: serverEnv.runtimeName,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    runtimeContract: {
      requiredKeys: runtimeValidation.requiredKeys,
      missingKeys: runtimeValidation.missingKeys,
    },
    // Worker liveness is never included here: it enqueues a real job and waits for a worker to
    // consume it, which is not something a health payload may do per request.
    connectors: await getConnectorStatusPayload({
      includeLiveChecks,
      includeWorkerLiveness: false,
    }),
  };
};
