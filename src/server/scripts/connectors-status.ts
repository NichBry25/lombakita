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
import { setDefaultResultOrder } from "node:dns";
import { pathToFileURL } from "node:url";

import type { DeployEnvironment } from "@/config/env-shape";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/scripts/connectors-status");

// Scoped to this script, deliberately NOT set app-wide. Neon publishes both A and AAAA records and
// returns them in rotating order; Node tries them in the order given rather than preferring IPv4.
// A GitHub runner has no IPv6 route and drops those packets silently, so an unlucky draw hangs
// until the client's connect timeout instead of failing fast. Vercel and Railway both have working
// IPv6 and would lose it for no benefit, which is why this belongs to the CI entry point only.
setDefaultResultOrder("ipv4first");

import {
  assertEnvFileLoaded,
  describeEnvFileLoad,
  ENV_PATH_FLAG,
  hasFlag,
  loadEnvFile,
  readFlagValue,
} from "@/server/scripts/env-file";

const argv = process.argv.slice(2);

/**
 * The environment this command line DECLARED, or nothing.
 *
 * `--environment` names the file `vercel pull` wrote, so a value like `staging` is not an error
 * here — it is simply not a declaration this process can hold an expectation for. Anything but the
 * two deployed environments therefore passes nothing on, and the identity check it would reach is
 * left with no expectation rather than an interpreted one.
 */
export const declaredEnvironmentFromFlag = (
  value: string | undefined,
): DeployEnvironment | undefined =>
  value === "preview" || value === "production" ? value : undefined;

const run = async (): Promise<void> => {
  const environmentFlag = readFlagValue(argv, "--environment");

  const load = loadEnvFile({
    environment: environmentFlag,
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

  const declaredEnvironment = declaredEnvironmentFromFlag(environmentFlag);

  const payload = await getConnectorStatusPayload({
    includeLiveChecks: hasFlag(argv, "--live"),
    includeWorkerLiveness: hasFlag(argv, "--worker"),
    ...(declaredEnvironment ? { declaredEnvironment } : {}),
  });

  console.log(JSON.stringify(payload, null, 2));

  const hasBlockingFailure = payload.connectors.some(
    (item) => item.configured && item.live === "down",
  );

  if (hasBlockingFailure) {
    process.exitCode = 1;
  }
};

// Runs on load, because this file IS the command: `npm run connectors:status` executes it as the
// entry module and nothing else imports it. The comparison keeps the flag-to-declaration mapping
// above importable from a test without the runner opening a connection to anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
}
