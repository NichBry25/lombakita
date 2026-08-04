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
  /**
   * Extra attempts after the first failure. Defaults to none, which is right for an always-on
   * service: retrying one that is genuinely down only doubles how long the gate takes to say so.
   *
   * Set it where a first attempt can fail for a reason that resolves by itself. The database is
   * the case that exists today — it scales to zero, so the first connection after an idle period
   * pays the wake-up, and Neon's host is dual-stack while a GitHub runner has no IPv6 route, so a
   * first attempt can also hang on an address it can never reach. A second attempt gets a woken
   * compute and a fresh address draw.
   */
  retries?: number;
}): Promise<ConnectorReadiness> => {
  const { name, configured, includeLiveChecks, probe, retries = 0 } = options;

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

  const attempts = retries + 1;
  let lastDetail = "connector probe did not run";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probe();

      if (attempt === 1) {
        return { name, configured, live: "up" };
      }

      // A recovery is reported rather than hidden. If a connector starts needing its retry on
      // every run, that is a service degrading, and a silent retry would present it as healthy
      // right up until the day both attempts fail.
      const detail = `recovered on attempt ${attempt} of ${attempts} (first failure: ${lastDetail})`;

      logger.warn("Connector probe recovered after retry", { connector: name, detail });

      return { name, configured, live: "up", detail };
    } catch (error) {
      lastDetail = toSafeErrorMessage(error);

      logger.warn("Connector probe failed", {
        connector: name,
        detail: lastDetail,
        attempt,
        attempts,
      });
    }
  }

  return {
    name,
    configured,
    live: "down",
    detail: attempts === 1 ? lastDetail : `${lastDetail} (after ${attempts} attempts)`,
  };
};
