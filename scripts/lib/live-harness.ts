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
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch {
  // .env.local is optional; fall back to ambient environment.
}

process.env.APP_ENV = "test";

export const databaseUrl = (() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
})();

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
