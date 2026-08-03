/**
 * Deploy gate, layer 2: can this environment's credentials actually REACH each connector?
 *
 *   npm run connectors:status              # configuration only, no network
 *   npm run connectors:status:live         # opens a real connection to each configured connector
 *   npm run connectors:status:worker       # adds worker liveness (enqueues a real probe job)
 *
 * Pass --environment=<preview|production> to read the file `vercel pull` wrote, and
 * --require-env-file to fail when that file is absent rather than silently checking an empty
 * environment.
 */
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/scripts/connectors-status");

import {
  assertEnvFileLoaded,
  describeEnvFileLoad,
  ENV_PATH_FLAG,
  hasFlag,
  loadEnvFile,
  readFlagValue,
} from "@/server/scripts/env-file";

const argv = process.argv.slice(2);

const run = async (): Promise<void> => {
  const load = loadEnvFile({
    environment: readFlagValue(argv, "--environment"),
    explicitPath: readFlagValue(argv, ENV_PATH_FLAG),
  });

  console.log(describeEnvFileLoad(load));

  if (hasFlag(argv, "--require-env-file")) {
    assertEnvFileLoaded(load);
  }

  // Imported dynamically because serverEnv snapshots process.env at module load
  // (env.server.ts:153). A static import would bind the environment as it stood BEFORE the file
  // above was read, and every probe would run against the wrong values.
  const { getConnectorStatusPayload } = await import("@/server/connectors/status");

  const payload = await getConnectorStatusPayload({
    includeLiveChecks: hasFlag(argv, "--live"),
    includeWorkerLiveness: hasFlag(argv, "--worker"),
  });

  console.log(JSON.stringify(payload, null, 2));

  const hasBlockingFailure = payload.connectors.some(
    (item) => item.configured && item.live === "down",
  );

  if (hasBlockingFailure) {
    process.exitCode = 1;
  }
};

run()
  .catch((error: unknown) => {
    console.error(
      `\nConnector status check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  // Redis and Postgres clients hold open sockets, so the event loop never drains and the process
  // would hang after reporting. Exiting explicitly is what makes this usable as a CI step.
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
