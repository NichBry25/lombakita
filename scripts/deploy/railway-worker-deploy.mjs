/**
 * Deploy the Railway worker and report the BUILD's outcome, not the log stream's.
 *
 *   node scripts/deploy/railway-worker-deploy.mjs [serviceName]
 *
 * `railway up --ci` streams build logs and derives its exit code from that stream, so it exits 1
 * when it merely loses the connection — as it did on run #30923921869, where the build went on to
 * succeed and the worker booted correctly while CI reported failure and SKIPPED the production
 * smoke test. A deploy step that cries wolf is not harmless: it trains an operator to wave through
 * the red step that finally means something.
 *
 * So this detaches from the stream and polls Railway for the deployment's real status. Build logs
 * remain available at the URL `railway up` prints.
 *
 * The new deployment is identified by its id CHANGING, never by "the latest one" — a poll issued
 * before Railway registers the new deployment would otherwise read the PREVIOUS deployment's
 * terminal SUCCESS and report a deploy that never happened.
 */

import { spawnSync } from "node:child_process";

const SERVICE_NAME = process.argv[2] ?? "worker";
const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 15 * 60_000;

// Railway reports these once a deployment stops moving. Anything else means "still working".
const SUCCESS_STATUS = "SUCCESS";
const FAILURE_STATUSES = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runRailway = (args) => {
  return spawnSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * Latest deployment per worker service instance, keyed by instance id.
 *
 * Every environment is walked rather than assuming which one the token is scoped to: a project
 * token may expose one environment or several, and guessing wrong would poll the wrong worker.
 */
const readWorkerDeployments = () => {
  const result = runRailway(["status", "--json"]);

  if (result.status !== 0) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const deployments = new Map();

  for (const environment of parsed.environments?.edges ?? []) {
    for (const instance of environment.node?.serviceInstances?.edges ?? []) {
      const service = instance.node;

      if (service?.serviceName !== SERVICE_NAME) {
        continue;
      }

      deployments.set(service.id, {
        environmentName: environment.node.name,
        deploymentId: service.latestDeployment?.id ?? null,
        status: service.latestDeployment?.status ?? null,
      });
    }
  }

  return deployments;
};

const findChangedDeployment = (before, after) => {
  for (const [instanceId, current] of after) {
    const previous = before.get(instanceId);

    if (current.deploymentId && current.deploymentId !== previous?.deploymentId) {
      return current;
    }
  }

  return null;
};

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

const before = readWorkerDeployments();

if (!before) {
  fail(`Could not read Railway status before deploying. Is RAILWAY_TOKEN set?`);
}

if (before.size === 0) {
  fail(`No Railway service named "${SERVICE_NAME}" is visible to this token.`);
}

for (const [, entry] of before) {
  console.log(`current ${entry.environmentName}/${SERVICE_NAME}: ${entry.status ?? "none"}`);
}

console.log(`\nuploading to ${SERVICE_NAME}…`);

const upload = runRailway(["up", "--detach", "--service", SERVICE_NAME]);

console.log(upload.stdout?.trim() ?? "");

if (upload.status !== 0) {
  fail(`railway up failed to upload:\n${upload.stderr?.trim() ?? "(no stderr)"}`);
}

const deadline = Date.now() + TIMEOUT_MS;
let lastReported = null;

while (Date.now() < deadline) {
  await sleep(POLL_INTERVAL_MS);

  const after = readWorkerDeployments();

  // A transient status failure is not a deploy failure — keep polling until the deadline.
  if (!after) {
    continue;
  }

  const changed = findChangedDeployment(before, after);

  if (!changed) {
    continue;
  }

  if (changed.status !== lastReported) {
    console.log(`${changed.environmentName}/${SERVICE_NAME}: ${changed.status}`);
    lastReported = changed.status;
  }

  if (changed.status === SUCCESS_STATUS) {
    console.log(`\nRESULT: worker deployed to ${changed.environmentName}`);
    process.exit(0);
  }

  if (FAILURE_STATUSES.has(changed.status)) {
    fail(`RESULT: worker deployment ended as ${changed.status}. See the build logs URL above.`);
  }
}

fail(
  `RESULT: worker deployment did not reach a terminal status within ${TIMEOUT_MS / 60_000} minutes. ` +
    `It may still be building — check the build logs URL above before redeploying.`,
);
