/**
 * Shared bootstrap for scripts that drive the REAL app services against real infrastructure —
 * a real Postgres connection, and (where the script needs it) real R2.
 *
 * These scripts exist because the unit suite mocks its dependencies. A mocked `tx.execute` makes
 * an advisory lock a no-op; a mocked `listObjects` makes a purge that deletes nothing look
 * identical to one that deletes everything. Anything whose correctness lives in the infrastructure
 * rather than in the branch above it has to be proven here or not at all.
 *
 * Import this module FIRST in a script, and load every `@/`-aliased module with a dynamic
 * `await import(...)` inside the script body. ESM evaluates a module's dependencies before its own
 * body, so a static `@/` import anywhere would run the app's db client before APP_ENV is set below
 * and fail assertRuntimeEnv("web") with an opaque env error.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { isLocalDatabaseHost, isLoopbackUrl, parseDatabaseHost } from "./local-database-host";

// WHICH FILE A VALUE CAME FROM, recorded as it is read rather than reconstructed afterwards. A
// shell export silently overriding .env.local, or .env.local silently filling a variable the
// operator believed they had exported, both end with a script connecting somewhere its author did
// not intend. The banner below reports the answer on every run; guessing it later is not possible,
// because by then both look identical in `process.env`.
type EnvSource = "shell export" | ".env.local" | "unset";
const envSources = new Map<string, EnvSource>();

try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!key) continue;
    if (key in process.env) {
      envSources.set(key, "shell export");
      continue;
    }
    process.env[key] = value;
    envSources.set(key, ".env.local");
  }
} catch {
  // .env.local is optional; fall back to ambient environment.
}

const sourceOf = (key: string): EnvSource =>
  envSources.get(key) ?? (process.env[key] ? "shell export" : "unset");

process.env.APP_ENV = "test";

export const databaseUrl = (() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
})();

export const redisUrl = process.env.REDIS_URL ?? null;

/**
 * Refuses to let this module finish loading unless every connection string it resolved is loopback.
 *
 * AT MODULE SCOPE, and that placement is the guard. It used to be a function each script called for
 * itself, which made it a convention: three of the eleven scripts here called it and the other
 * eight did not, and nothing could tell the difference between a script that had considered the
 * question and one that had never heard of it. Importing this module now answers it, so the next
 * script inherits the refusal by existing rather than by remembering.
 *
 * These scripts write. They seed ledger rows, delete residue, and drive races to completion, and
 * every one of those is indistinguishable from real data afterwards or has no application path that
 * could undo it. A pasted connection string is an ordinary mistake; this is what makes it a stopped
 * run rather than a discovered one.
 */
const assertLocalInfrastructure = (): void => {
  const banner = [["DATABASE_URL", databaseUrl] as const, ["REDIS_URL", redisUrl] as const].map(
    ([key, url]) => {
      const host = url === null ? "unset" : (parseDatabaseHost(url) ?? "<unparseable>");
      return `  ${key.padEnd(13)} host=${host.padEnd(24)} from ${sourceOf(key)}`;
    },
  );

  // PRINTED BEFORE THE VERDICT, and on every run rather than only on refusal. A run that connects
  // to the wrong local database is not refused by anything below — the point of showing the host is
  // that someone reading the output can see where the writes went.
  console.log("live-harness resolved:");
  for (const line of banner) console.log(line);

  const remote = [["DATABASE_URL", databaseUrl] as const, ["REDIS_URL", redisUrl] as const].filter(
    ([, url]) => url !== null && !isLoopbackUrl(url),
  );

  if (remote.length === 0) return;

  const named = remote
    .map(([key, url]) => `${key} at "${parseDatabaseHost(url as string) ?? "<unparseable>"}"`)
    .join(", ");

  throw new Error(
    `live-harness refuses to run against non-local infrastructure: ${named}. Every script built ` +
      "on this harness writes, and it is restricted to local development services",
  );
};

assertLocalInfrastructure();

// Wide enough that concurrent transactions land on SEPARATE backends and genuinely contend. With
// max:1 the racers serialize on the connection itself and the script proves nothing while passing.
// Scripts that never run two operations at once are unaffected by the extra headroom.
export const POOL_SIZE = 8;

export const openPool = async (maxConnections: number = POOL_SIZE) => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const client = postgres(databaseUrl, { max: maxConnections, prepare: false });
  const db = drizzle(client, { schema });
  return { client, db };
};

// `failureCount` is a FUNCTION, not a getter or a plain number: a getter is silently snapshotted to
// its value-at-spread-time by object destructuring, which turns a script reporting FAIL lines into
// one exiting 0. A call cannot be snapshotted.
export const createChecker = () => {
  let failures = 0;
  const check = (condition: boolean, label: string): void => {
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
    if (!condition) failures += 1;
  };
  const failureCount = (): number => failures;
  return { check, failureCount };
};

// Unwraps the single row a seed INSERT ... RETURNING or a scalar SELECT is expected to produce.
// An empty result means the seed did not do what the script assumes, which must stop the run —
// letting an `undefined` flow into an assertion is how a check passes on nothing.
export const oneRow = <T>(rows: readonly T[], description: string): T => {
  const row = rows[0];
  if (!row) {
    throw new Error(`Expected one ${description} row, received ${rows.length}`);
  }
  return row;
};

// Iteration count, overridable with RACE_ITERATIONS. A guard-removal probe of a narrow interleaving
// may need more attempts than a normal run to catch the defect.
export const resolveIterations = (fallback: number): number => {
  const parsed = Number.parseInt(process.env.RACE_ITERATIONS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const finish = (failures: number, label: string): never => {
  console.log(`\n${failures === 0 ? `ALL ${label} CHECKS PASSED` : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

export { isLocalDatabaseHost, parseDatabaseHost } from "./local-database-host";

// Refuses to continue unless `url` is a loopback database, naming the host it rejected.
//
// For scripts that seed or remove rows in financial tables. A connection string pointed at a shared
// or deployed database is a plausible mistake (a paste, an exported shell) and neither direction
// is recoverable by inspection afterwards: seeded fixtures are indistinguishable from real ledger
// rows, and a ledger row deleted from the wrong database has no application path that could restore
// it. Called before the pool opens, so the refusal precedes the connection rather than the query.
export const assertLocalDatabase = (url: string, purpose: string): void => {
  if (isLocalDatabaseHost(url)) {
    return;
  }

  throw new Error(
    `${purpose} refuses to run against host "${parseDatabaseHost(url) ?? "<unparseable>"}". It ` +
      "operates on financial tables, so it is restricted to a local development database",
  );
};
