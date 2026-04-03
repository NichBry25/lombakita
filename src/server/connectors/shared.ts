import { logger } from "@/lib/logger";

export type ConnectorLiveState = "up" | "down" | "skipped";

export type ConnectorReadiness = {
  name: string;
  configured: boolean;
  live: ConnectorLiveState;
  detail?: string;
};

const toSafeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return "unexpected connector error";
};

export const runConnectorProbe = async (options: {
  name: string;
  configured: boolean;
  includeLiveChecks: boolean;
  probe: () => Promise<void>;
}): Promise<ConnectorReadiness> => {
  const { name, configured, includeLiveChecks, probe } = options;

  if (!configured) {
    return {
      name,
      configured,
      live: "skipped",
      detail: "not configured",
    };
  }

  if (!includeLiveChecks) {
    return {
      name,
      configured,
      live: "skipped",
      detail: "live probe disabled",
    };
  }

  try {
    await probe();

    return {
      name,
      configured,
      live: "up",
    };
  } catch (error) {
    const detail = toSafeErrorMessage(error);

    logger.warn("Connector probe failed", {
      connector: name,
      detail,
    });

    return {
      name,
      configured,
      live: "down",
      detail,
    };
  }
};
