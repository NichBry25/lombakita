import { assertRuntimeEnv, serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { createAsyncWorkerRuntime } from "@/server/async/worker-runtime";

const bindSignalHandlers = (shutdown: (signal: NodeJS.Signals) => Promise<void>): void => {
  const supportedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  for (const signal of supportedSignals) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
};

export const runWorkerBootstrap = async (): Promise<void> => {
  assertRuntimeEnv("worker");

  const runtime = createAsyncWorkerRuntime();
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    logger.info("Worker shutdown requested", {
      signal,
      runtimeName: serverEnv.runtimeName,
      appEnv: serverEnv.appEnv,
    });

    try {
      await runtime.stop();
      process.exitCode = 0;
    } catch (error) {
      logger.error("Worker shutdown failed", {
        signal,
        errorMessage: error instanceof Error ? error.message : "unexpected shutdown error",
      });
      process.exitCode = 1;
    }
  };

  bindSignalHandlers(shutdown);

  await runtime.start();
};
