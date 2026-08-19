// Test-only. How a database-backed suite finds its connection string, and — the part that matters —
// what it does when there isn't one.
//
// THE PROBLEM THIS EXISTS TO CLOSE (DEC-0142). Every DB-backed suite here is written so
// that deleting its guard makes it FAIL, because the unit suite mocks the database and a removed
// CHECK leaves mocked tests green. That property is worth nothing if the suite never runs, and it
// never ran: `npm run test` does not set DATABASE_URL, so `describe.skipIf(!DATABASE_URL)` skipped
// the entire finance constraint suite on every CI run since it was written. A skipped suite reports
// the same green tick as a passing one. It was the ONLY proof any finance CHECK exists.
//
// So the skip stays — a developer without a local database should still be able to run `npm test` —
// but it is no longer available to CI. `REQUIRE_DB_TESTS=1` turns a missing database from a skip
// into a hard failure at module load, and CI sets it. If someone removes the Postgres service from
// the workflow, the suites do not quietly go back to skipping; the job goes red naming the reason.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/testing/database-url");

/**
 * Reads DATABASE_URL from the environment, falling back to `.env.local`.
 *
 * The fallback is deliberate and is not laziness: exporting DATABASE_URL into the shell also brings
 * APP_BASE_URL and friends along with it, which breaks the suites that assert what happens when
 * those are ABSENT. Reading the one variable out of the file keeps the rest of the environment
 * untouched.
 */
const readDatabaseUrl = (): string | undefined => {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    return undefined;
  }

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (match?.[1]) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
};

export const TEST_DATABASE_URL = readDatabaseUrl();

/**
 * Reads one named variable from the environment, falling back to `.env.local`.
 *
 * Same narrow-read reasoning as `readDatabaseUrl`: pull the single value out of the file rather
 * than loading it, so suites asserting on absent variables keep seeing them absent.
 */
const readEnvValue = (name: string): string | undefined => {
  if (process.env[name]) {
    return process.env[name];
  }

  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    return undefined;
  }

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(new RegExp(`^${name}=(.*)$`));
    if (match?.[1]) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
};

/**
 * A connection that may execute DDL, for the one probe that needs to remove a table to prove what
 * happens without it.
 *
 * The ordinary `DATABASE_URL` role deliberately cannot: locally it is `lombakita_app` and the
 * tables are owned by `lombakita_migrate`, so a `DROP TABLE` is refused with SQLSTATE 42501. That
 * separation is a real protection — the application can never drop a finance table — and it is not
 * something to work around at runtime. It does mean a probe asking "what does the code do when this
 * table is absent" has to borrow the owner's connection, which is what this is for.
 *
 * Prefers the migration role and falls back to `DATABASE_URL`, which covers CI: there the single
 * `postgres` superuser both migrates and serves, so the fallback IS the owner.
 */
export const TEST_DDL_DATABASE_URL = readEnvValue("MIGRATION_DATABASE_URL") ?? TEST_DATABASE_URL;

/**
 * Whether a database is MANDATORY for this run. Set by CI (see .github/workflows/ci.yml).
 *
 * A separate variable rather than keying off `CI` itself, so that a workflow which deliberately has
 * no database — the contrast self-test job, for instance — is not forced to stand one up.
 */
export const databaseTestsRequired = process.env.REQUIRE_DB_TESTS === "1";

if (databaseTestsRequired && !TEST_DATABASE_URL) {
  // Thrown at module load, so the importing suite fails loudly as a file-level error instead of
  // reporting zero tests and a green tick. This is the tripwire: it fires the moment CI is running
  // without the database it is supposed to have.
  throw new Error(
    "REQUIRE_DB_TESTS=1 but no DATABASE_URL is set. This run is configured to REQUIRE a database, " +
      "and a database-backed suite has nothing to run against. Either provision the Postgres " +
      "service for this job or unset REQUIRE_DB_TESTS — do not let these suites silently skip.",
  );
}

/**
 * The value for `describe.skipIf(...)`.
 *
 * Always false when a database is required, so a suite can never skip in CI. When the throw above
 * has already fired this is unreachable, and that redundancy is on purpose: the two mechanisms fail
 * independently, and the cheap one being wrong should not restore the silent skip.
 */
export const skipWithoutDatabase = !databaseTestsRequired && !TEST_DATABASE_URL;
