/**
 * The guarded migration entry point: `npm run db:migrate:guarded`.
 *
 * WHAT THIS REPLACES, AND WHY THE OLD SHAPE COULD NOT BE FIXED IN PLACE. It used to be a guard
 * process followed by `drizzle-kit migrate` as a SEPARATE process (`package.json` chained them with
 * `&&`), and the two resolved `MIGRATION_DATABASE_URL ?? DATABASE_URL` independently. So the guard
 * could pass on one URL and the migrator run against another, and neither the guard nor the gate
 * ever asked the server which database it was on — a connection string's own path is the claim
 * under test, not the evidence (LAUNCH-D150, LAUNCH-D124, DEC-0207).
 *
 * THE THREE THINGS THIS DOES THAT THE OLD ONE DID NOT:
 *
 *   1. IT ASKS THE SERVER, and prints the answer before it decides anything. `current_database()`
 *      and `current_user` come from the process on the other end of the socket, so the connection
 *      string cannot name a database the server disagrees with.
 *   2. IT TYPES THE CONFIRMATION. Production and preview require `--confirm=<database name>`, and the
 *      name is compared against what THE SERVER reported, never against the constant. A value read
 *      out of `.env.production.local` cannot satisfy it, which is what makes it a confirmation
 *      rather than a stored flag.
 *   3. IT HANDS THE VERIFIED URL TO THE MIGRATOR, in the child's environment. The child is this
 *      process's own `node_modules/.bin/drizzle-kit`, so there is exactly one URL on the path and it
 *      is the one whose identity was just read. `drizzle.config.ts` is not modified: `loadEnvFile`
 *      does not override a variable already set, so the child resolves the verified URL.
 *
 * CONFIRM_PROD_MIGRATION IS NOT READ AS AUTHORIZATION, EVER AGAIN (LAUNCH-D151). Its presence is a
 * REFUSAL, from any source, whatever its value. A variable that lives in a shell profile or a pulled
 * env file outlives the intent that put it there, and an "I am sure" string is exactly the thing a
 * stored environment can satisfy on an operator's behalf. No production connection is opened on this
 * path during implementation or testing.
 *
 * NO CREDENTIAL IS EVER PRINTED. Not the URL, not the user out of the URL, not the password. The
 * printed line carries the server's own names and the URL's HOSTNAME only.
 *
 * THE DECISIONS ARE PURE AND THE RUNNER IS THIN, so every refusal below is unit-testable without a
 * database. `planGuardedMigration` decides everything that can be decided from arguments and the
 * environment; `findTargetRefusal` decides everything that depends on the server's answer; `run`
 * connects, prints and spawns, and decides nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { CANONICAL_DATABASE_NAME, CANONICAL_DATABASE_ROLE } from "@/config/env-shape";
import {
  identityMismatch,
  readServerIdentity,
  type ServerIdentity,
} from "@/server/scripts/database-identity";
import { readFlagValue } from "@/server/scripts/env-file";
import { isLoopbackUrl, parseDatabaseHost } from "../../../scripts/lib/local-database-host";

/** The two variables that may name the migration target, in the order `drizzle.config.ts` prefers. */
const URL_VARIABLES = ["MIGRATION_DATABASE_URL", "DATABASE_URL"] as const;

type UrlVariable = (typeof URL_VARIABLES)[number];

/** Loaded in this order, exactly as this entry point always has. */
const LOCAL_ENV_FILES = [".env.local", ".env"] as const;

const ACCEPTED_ENVIRONMENTS = ["local", "preview", "production"] as const;

type DeclaredEnvironment = (typeof ACCEPTED_ENVIRONMENTS)[number];

const isDeclaredEnvironment = (value: string): value is DeclaredEnvironment => {
  return ACCEPTED_ENVIRONMENTS.some((candidate) => candidate === value);
};

const USAGE =
  "Usage: npm run db:migrate:guarded -- [--environment=local|preview|production] " +
  "[--confirm=<database name>]";

/**
 * Where each URL variable's value came from, so the printed target line can say it.
 *
 * The distinction is the whole of LAUNCH-D151: a value exported in a shell outranks every file this
 * loads, because `process.loadEnvFile` never overrides a variable already present, so a stale export
 * silently redirects the run while the file it came from reads correctly.
 */
export type UrlSources = Readonly<Record<UrlVariable, string>>;

/**
 * Loads the local env files, recording which source supplied each URL variable.
 *
 * PRECEDENCE IS OBSERVED, NOT ASSUMED. Every variable already present in `process.env` BEFORE the
 * first load is attributed to the shell, because nothing loaded here can change it. Everything else
 * is attributed to the first file that introduced it.
 */
export const loadLocalEnvFilesRecordingSources = (): UrlSources => {
  const presentBefore = new Set(URL_VARIABLES.filter((item) => process.env[item] !== undefined));
  const suppliedBy = new Map<UrlVariable, string>();

  for (const file of LOCAL_ENV_FILES) {
    if (!existsSync(file)) {
      continue;
    }

    process.loadEnvFile(file);

    for (const variable of URL_VARIABLES) {
      const alreadyAttributed = suppliedBy.has(variable) || presentBefore.has(variable);

      if (!alreadyAttributed && process.env[variable] !== undefined) {
        suppliedBy.set(variable, `file:${file}`);
      }
    }
  }

  const sourceOf = (variable: UrlVariable): string => {
    if (presentBefore.has(variable)) {
      return "shell";
    }

    return suppliedBy.get(variable) ?? "unset";
  };

  return {
    MIGRATION_DATABASE_URL: sourceOf("MIGRATION_DATABASE_URL"),
    DATABASE_URL: sourceOf("DATABASE_URL"),
  };
};

export type MigrationPlan = {
  /** `local` when nothing was declared. */
  environment: DeclaredEnvironment;
  /** How the target line reports it: `local (default)` when `--environment` was absent. */
  environmentLabel: string;
  url: string;
  /** Which of the two variables supplied `url`, so a refusal can name it. */
  variable: UrlVariable;
  source: string;
  /** The `--confirm` value, or null when absent. Ignored under local, required for the other two. */
  confirm: string | null;
};

export type MigrationDecision =
  | { kind: "refused"; message: string }
  | { kind: "ready"; plan: MigrationPlan };

/**
 * Everything decidable from arguments and the environment, and nothing that needs a connection.
 *
 * Ordered as the arguments are resolved: environment, then URL, then the stale confirmation, then
 * the confirmation this pass requires. Every refusal here happens BEFORE any connection is opened,
 * which is why none of them prints a target line — there is no server answer to print yet.
 */
export const planGuardedMigration = (input: {
  argv: string[];
  env: Readonly<Record<string, string | undefined>>;
  sources: UrlSources;
}): MigrationDecision => {
  const refused = (message: string): MigrationDecision => ({ kind: "refused", message });

  const declared = readFlagValue(input.argv, "--environment");

  if (declared !== undefined && !isDeclaredEnvironment(declared)) {
    return refused(`Unknown --environment ${JSON.stringify(declared)}. ${USAGE}`);
  }

  const environment: DeclaredEnvironment = declared ?? "local";

  const migrationUrl = input.env.MIGRATION_DATABASE_URL;
  const databaseUrl = input.env.DATABASE_URL;
  const url = migrationUrl ?? databaseUrl;

  if (!url) {
    return refused(
      "DATABASE_URL or MIGRATION_DATABASE_URL must be configured before running migrations",
    );
  }

  const variable: UrlVariable =
    migrationUrl !== undefined ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";

  if (input.env.CONFIRM_PROD_MIGRATION !== undefined) {
    return refused(
      "CONFIRM_PROD_MIGRATION is no longer read. Remove it from your shell and env files; " +
        "confirm with --confirm=<database name> instead.",
    );
  }

  const confirm = readFlagValue(input.argv, "--confirm") ?? null;

  if (environment !== "local" && confirm === null) {
    return refused(
      `--environment=${environment} requires --confirm=<database name>: the name the server ` +
        `reports for that database, typed by the operator. A value stored in an environment ` +
        `cannot satisfy this. ${USAGE}`,
    );
  }

  return {
    kind: "ready",
    plan: {
      environment,
      environmentLabel: declared === undefined ? "local (default)" : declared,
      url,
      variable,
      source: input.sources[variable],
      confirm,
    },
  };
};

const PROTECTED_DATABASE_NAMES: readonly string[] = Object.values(CANONICAL_DATABASE_NAME);

/**
 * Everything that depends on the server's answer, decided against the identity the caller read.
 *
 * Pure: the identity is passed in, so each branch is reachable in a unit test without a database.
 * Under local the two refusals are the disposable-target pair — the same host predicate the reset
 * guard uses, plus the deployed names — because the default environment is what a forgotten flag
 * reaches, and a default that can reach a managed database is not a default.
 */
export const findTargetRefusal = (input: {
  plan: MigrationPlan;
  identity: ServerIdentity;
}): string | null => {
  const { plan, identity } = input;

  if (plan.environment === "local") {
    if (!isLoopbackUrl(plan.url)) {
      return (
        `refusing to migrate: ${plan.variable} points at ` +
        `"${parseDatabaseHost(plan.url) ?? "<unparseable>"}", which is not loopback. The default ` +
        `environment is local and a local migration never leaves this machine; aim at a managed ` +
        `database with --environment=<preview|production> --confirm=<database name>.`
      );
    }

    if (PROTECTED_DATABASE_NAMES.includes(identity.database)) {
      return (
        `refusing to migrate: the server on this connection reports current_database() = ` +
        `"${identity.database}", which is a protected database ` +
        `(${PROTECTED_DATABASE_NAMES.join(", ")}). This is the database's own answer, not the ` +
        `connection string's, so there is no value to correct here other than where this process ` +
        `is pointed.`
      );
    }

    return null;
  }

  const expectedDatabase = CANONICAL_DATABASE_NAME[plan.environment];
  const expectedRole = CANONICAL_DATABASE_ROLE[plan.environment].migration;

  if (identityMismatch(identity, { database: expectedDatabase, role: expectedRole }) !== null) {
    return (
      `Connected to database "${identity.database}" as "${identity.role}", but ` +
      `${plan.environment} must migrate "${expectedDatabase}" as "${expectedRole}". Refusing: a ` +
      `run here would apply to the wrong database. Fix MIGRATION_DATABASE_URL rather than this ` +
      `check.`
    );
  }

  if (plan.confirm !== identity.database) {
    return (
      `--confirm=${JSON.stringify(plan.confirm)} does not match the name the server reports for ` +
      `this connection, "${identity.database}". Type the name the server gave, not the name from ` +
      `configuration.`
    );
  }

  return null;
};

/**
 * Reports a refusal and stops. `never`, so a caller's control flow narrows on it.
 *
 * `process.exit` rather than `process.exitCode`: every refusal is decided before the child is
 * spawned, so there is nothing in flight to unwind, and a refusal that could be overtaken by the
 * rest of the runner would be a refusal that does not stop the migration.
 */
const refuse: (message: string) => never = (message) => {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
};

/**
 * Exported so a test can drive the whole path with the connection and the child process stubbed,
 * which is the only way to prove that the URL the migrator receives is the one whose identity was
 * read. The pure functions above cover the decisions; this covers the wiring.
 */
export const run = async (): Promise<void> => {
  const decision = planGuardedMigration({
    argv: process.argv.slice(2),
    env: process.env,
    sources: loadLocalEnvFilesRecordingSources(),
  });

  if (decision.kind === "refused") {
    refuse(decision.message);
  }

  const { plan } = decision;

  // Imported dynamically because `@/config/env.server` snapshots `process.env` at module load
  // (env.server.ts:170), and the env files are only read above this line.
  const { resolveDatabaseSslOption } = await import("@/server/db/ssl-options");

  const ssl = resolveDatabaseSslOption();

  // Connection setup mirrored from verify-schema-drift.ts, so both lanes reach a server the same way.
  const sql = postgres(plan.url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  let identity: ServerIdentity;

  try {
    identity = await readServerIdentity(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }

  // PRINTED BEFORE ANY REFUSAL THAT NEEDS THE SERVER, so a refused run still says which database
  // refused it. A run refused here has already been read from; nothing has been written.
  console.log(
    `migration target: database=${identity.database} role=${identity.role} ` +
      `host=${parseDatabaseHost(plan.url) ?? "<unparseable>"} source=${plan.source} ` +
      `environment=${plan.environmentLabel}`,
  );

  const targetRefusal = findTargetRefusal({ plan, identity });

  if (targetRefusal !== null) {
    refuse(targetRefusal);
  }

  // Absolute, from this process's own install: the migrator that runs is the one this repository
  // resolved, and `spawnSync` with an absolute path cannot pick up a different `drizzle-kit` from
  // PATH.
  const drizzleKit = join(process.cwd(), "node_modules", ".bin", "drizzle-kit");

  if (!existsSync(drizzleKit)) {
    refuse(
      `drizzle-kit is not installed at ${drizzleKit}, so the verified migrations have nothing to ` +
        `run them. Run \`npm install\` and try again.`,
    );
  }

  // The verified URL, in the child's environment. `loadEnvFile` does not override a set variable, so
  // `drizzle.config.ts` resolves this one whatever the shell or the files said.
  const child = spawnSync(drizzleKit, ["migrate"], {
    stdio: "inherit",
    env: { ...process.env, MIGRATION_DATABASE_URL: plan.url },
  });

  // A child ended by a signal has a null status. It did not migrate successfully and it did not
  // refuse, so it exits 1 rather than reporting a status it never produced.
  process.exitCode = child.status ?? 1;
};

// Runs on load, because this file IS the command: `npm run db:migrate:guarded` executes it as the
// entry module and nothing else imports it. The comparison keeps the pure decisions above importable
// from a test without the runner connecting to anything, which is the only reason this is not an
// unconditional call.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error: unknown) => {
    console.error("Migration guard failed", error);
    process.exitCode = 1;
  });
}
