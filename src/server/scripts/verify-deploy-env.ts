/**
 * Deploy gate, layer 1: does this environment's configuration have the right SHAPE?
 *
 * Pure string validation, no network. Runs on the CI runner against the file
 * `vercel pull` just wrote, before `vercel build`, so a misconfigured environment never
 * produces a deployment.
 *
 *   npm run verify:deploy-env -- --environment=production --require-env-file
 *
 * Layer 2 (`npm run connectors:status:live`) opens real connections; this one catches the faults
 * that reach a connector as a confusing error, or that no connector check covers at all.
 */
import {
  DEPLOY_ENV_KEY_SPECS,
  findDeployConfigProblems,
  type DeployConfigProblem,
  type DeployEnvironment,
} from "@/config/env-shape";
import {
  assertEnvFileLoaded,
  describeEnvFileLoad,
  ENV_PATH_FLAG,
  hasFlag,
  loadEnvFile,
  readFlagValue,
} from "@/server/scripts/env-file";

const DEPLOY_ENVIRONMENTS: readonly DeployEnvironment[] = ["preview", "production"];

const parseEnvironment = (value: string | undefined): DeployEnvironment => {
  if (value && DEPLOY_ENVIRONMENTS.includes(value as DeployEnvironment)) {
    return value as DeployEnvironment;
  }

  throw new Error(
    `--environment must be one of ${DEPLOY_ENVIRONMENTS.join(" | ")} (received: ${value ?? "nothing"})`,
  );
};

const printProblem = (problem: DeployConfigProblem): void => {
  const severity = problem.severity === "error" ? "ERROR  " : "WARNING";

  console.log(`  ${severity}  ${problem.key.padEnd(24)} ${problem.problem}`);
};

const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const environment = parseEnvironment(readFlagValue(argv, "--environment"));

  const load = loadEnvFile({
    environment,
    explicitPath: readFlagValue(argv, ENV_PATH_FLAG),
  });

  console.log(describeEnvFileLoad(load));

  if (hasFlag(argv, "--require-env-file")) {
    assertEnvFileLoaded(load);
  }

  console.log(`environment: ${environment}\n`);

  const problems = findDeployConfigProblems(process.env, environment);
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");

  problems.forEach(printProblem);

  const inspected = DEPLOY_ENV_KEY_SPECS.length;
  const counts = `${errors.length} error(s), ${warnings.length} warning(s)`;

  console.log(
    errors.length === 0
      ? `\nRESULT: ${inspected} variables inspected, all well-formed — ${counts}`
      : `\nRESULT: FAILED — ${counts} across ${inspected} inspected variables`,
  );

  if (errors.length > 0) {
    process.exitCode = 1;
  }
};

// Message only, no stack: every throw on this path is an operational message written for whoever
// is reading a failed deploy log, and a stack trace buries it.
run().catch((error: unknown) => {
  console.error(
    `\nDeploy environment verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
