import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";

// Scaffolding only: Sentry SDK initialization is intentionally deferred.
export const sentryScaffold = {
  dsnConfigured: Boolean(serverEnv.sentryDsn),
  environment: publicEnv.appEnv,
};

export const initSentryScaffold = (): void => {
  if (!sentryScaffold.dsnConfigured) {
    return;
  }

  // Placeholder hook for future Sentry SDK initialization.
};
