import { existsSync } from "node:fs";

/**
 * Locates and loads the env file a deploy-time check should read.
 *
 * In CI this is the file `vercel pull --environment=<env>` just wrote, which holds the exact
 * values the deployment will run with — checking those is what makes the gate meaningful rather
 * than a check of the runner's own empty environment.
 *
 * `process.loadEnvFile` does NOT override variables already present in the process, matching
 * Node's `--env-file` semantics. On a CI runner none of these are set, so the file wins; locally
 * an exported shell value wins, which is what you want when trying a candidate value out.
 */

export type EnvFileLoad = {
  loadedFrom: string | null;
  candidates: string[];
};

/**
 * Callers expose this as `--env-path`, never `--env-file`. Node parses `--env-file` as one of its
 * own CLI options even when it appears after the script path, and exits before the script runs.
 */
export const ENV_PATH_FLAG = "--env-path";

export const readFlagValue = (argv: string[], flag: string): string | undefined => {
  const match = argv.find((item) => item.startsWith(`${flag}=`));

  return match?.slice(flag.length + 1);
};

export const hasFlag = (argv: string[], flag: string): boolean => argv.includes(flag);

const buildCandidates = (environment: string | undefined, explicitPath: string | undefined) => {
  if (explicitPath) {
    return [explicitPath];
  }

  const vercelPulled = environment ? [`.vercel/.env.${environment}.local`] : [];

  return [...vercelPulled, ".env.local", ".env"];
};

export const loadEnvFile = (options: {
  environment?: string;
  explicitPath?: string;
}): EnvFileLoad => {
  const candidates = buildCandidates(options.environment, options.explicitPath);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    process.loadEnvFile(candidate);

    return { loadedFrom: candidate, candidates };
  }

  return { loadedFrom: null, candidates };
};

/**
 * Always printed by the callers, so a log can never leave which values were checked ambiguous.
 * States only what was found — whether an absent file is tolerated is the caller's decision.
 */
export const describeEnvFileLoad = (load: EnvFileLoad): string => {
  if (load.loadedFrom) {
    return `env file: ${load.loadedFrom}`;
  }

  return `env file: none found (looked for ${load.candidates.join(", ")})`;
};

/**
 * Fails when no env file was found and the caller demanded one. Without this, a Vercel CLI change
 * that moves the pulled file would leave every check running against an empty environment and
 * reporting whatever that produces — the silent no-op this whole gate exists to prevent.
 */
export const assertEnvFileLoaded = (load: EnvFileLoad): void => {
  if (load.loadedFrom) {
    return;
  }

  throw new Error(
    `no env file found — looked for ${load.candidates.join(", ")}. ` +
      "Run `vercel pull --environment=<preview|production>` first, or drop --require-env-file " +
      "to check the ambient environment instead.",
  );
};
