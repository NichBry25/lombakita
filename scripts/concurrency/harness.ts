/**
 * Shared bootstrap for the live concurrency-race scripts in this directory.
 *
 * Every script here proves the same class of claim: that two genuinely concurrent Postgres
 * transactions serialize on a guard (an advisory lock or a compare-and-set). The unit suite cannot
 * prove that — it mocks the database, so `tx.execute` is a no-op and deleting a lock leaves the
 * whole suite green.
 *
 * The generic pieces (env bootstrap, connection pool, checker, exit reporting) live in
 * `scripts/lib/live-harness` and are re-exported here so a script in this directory has one import.
 * What this module adds is concurrency-specific: racing operations, accounting for which racer won,
 * and refusing to report a result under the wrong isolation level.
 *
 * Import this module FIRST in a script, and load every `@/`-aliased module with a dynamic
 * `await import(...)` inside the script body. ESM evaluates a module's dependencies before its own
 * body, so a static `@/` import anywhere would run the app's db client before APP_ENV is set by the
 * shared harness and fail assertRuntimeEnv("web") with an opaque env error.
 */

import { openPool } from "../lib/live-harness";

export {
  POOL_SIZE,
  assertLocalDatabase,
  createChecker,
  databaseUrl,
  finish,
  isLocalDatabaseHost,
  oneRow,
  openPool,
  resolveIterations,
} from "../lib/live-harness";

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
