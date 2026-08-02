/**
 * Shared bootstrap for the live concurrency-race scripts in this directory.
 *
 * Every script here proves the same class of claim: that two genuinely concurrent Postgres
 * transactions serialize on a guard (an advisory lock or a compare-and-set). The unit suite cannot
 * prove that — it mocks the database, so `tx.execute` is a no-op and deleting a lock leaves the
 * whole suite green.
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
export const POOL_SIZE = 8;

export const openPool = async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/server/db/schema");
  const client = postgres(databaseUrl, { max: POOL_SIZE, prepare: false });
  const db = drizzle(client, { schema });
  return { client, db };
};

// The result of running two operations concurrently: how many settled successfully, and the
// domain error code / HTTP status of each that did not. Errors without a `code` land in `other`,
// which is how an unexpected 23505 or a raw Postgres deadlock announces itself instead of being
// mistaken for the guard firing correctly.
export type RaceOutcome = {
  ok: number;
  failCodes: string[];
  failStatuses: (number | null)[];
  other: string[];
  sqlStates: string[];
  values: unknown[];
};

// Drizzle wraps a driver error in a DrizzleQueryError whose own `message` is just the failed SQL —
// the SQLSTATE lives on `cause`. Without unwrapping, a unique violation and a deadlock are
// indistinguishable in the output, and "neither racer deadlocked" cannot be asserted at all.
const findSqlState = (error: unknown, depth = 0): string | null => {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
    return candidate.code;
  }
  return findSqlState(candidate.cause, depth + 1);
};

export const DEADLOCK_SQLSTATE = "40P01";
export const UNIQUE_VIOLATION_SQLSTATE = "23505";

export const race = async (...operations: Array<() => Promise<unknown>>): Promise<RaceOutcome> =>
  settleAll(operations.map((operation) => operation()));

// Same accounting as `race`, for operations already in flight — a staggered start cannot be
// expressed as a list of thunks handed over all at once.
export const settleAll = async (operations: Array<Promise<unknown>>): Promise<RaceOutcome> => {
  const results = await Promise.allSettled(operations);
  const outcome: RaceOutcome = {
    ok: 0,
    failCodes: [],
    failStatuses: [],
    other: [],
    sqlStates: [],
    values: [],
  };

  for (const result of results) {
    if (result.status === "fulfilled") {
      outcome.ok += 1;
      outcome.values.push(result.value);
      continue;
    }
    const reason = result.reason as {
      code?: string;
      httpStatus?: number;
      status?: number;
      message?: string;
    };
    const sqlState = findSqlState(result.reason);
    if (sqlState) outcome.sqlStates.push(sqlState);

    // A domain error carries a string `code` AND an HTTP status; a driver error's `code` is a
    // 5-character SQLSTATE and belongs in `other`, where an assertion will notice it.
    const isDomainError =
      reason && typeof reason.code === "string" && reason.code !== sqlState;
    if (isDomainError) {
      outcome.failCodes.push(reason.code as string);
      outcome.failStatuses.push(reason.httpStatus ?? reason.status ?? null);
    } else {
      const suffix = sqlState ? ` [SQLSTATE ${sqlState}]` : "";
      outcome.other.push(`${reason?.message ?? String(result.reason)}${suffix}`);
    }
  }

  return outcome;
};

export const describeOutcome = (outcome: RaceOutcome): string => {
  const losers = outcome.failCodes
    .map((code, index) => `${code}(${outcome.failStatuses[index] ?? "?"})`)
    .join(", ");
  // Only the first line of an unexpected error: a Drizzle failure message carries the whole SQL
  // statement, which buries the SQLSTATE the reader actually needs.
  const unexpected = outcome.other.length
    ? ` unexpected=[${outcome.other.map((message) => message.split("\n")[0]).join("; ")}]`
    : "";
  const states = outcome.sqlStates.length ? ` sqlstates=[${outcome.sqlStates.join(",")}]` : "";
  return `ok=${outcome.ok} losers=[${losers}]${states}${unexpected}`;
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

// Every post-lock count and every CAS in this codebase is reasoned about under READ COMMITTED. A
// script that runs against a different isolation level is not testing the shipped semantics, so
// print it and refuse rather than reporting a pass that means something else.
export const assertReadCommitted = async (
  client: Awaited<ReturnType<typeof openPool>>["client"],
): Promise<void> => {
  const rows = await client<{ iso: string }[]>`
    SELECT current_setting('default_transaction_isolation') AS iso
  `;
  const isolation = rows[0]?.iso ?? "unknown";
  console.log(`DATABASE default_transaction_isolation = ${isolation}`);
  if (isolation !== "read committed") {
    throw new Error(
      `Expected READ COMMITTED isolation; found '${isolation}'. The guard reasoning does not carry over — re-verify before trusting any result.`,
    );
  }
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
