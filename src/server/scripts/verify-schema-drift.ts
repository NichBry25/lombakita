/**
 * BLOCKING schema-drift check for the deploy gate.
 *
 * `deploy.yml` ran no drift check at all and said so in a comment, so a deployment whose checkout
 * declared migrations the database had never applied went out reporting success, and the two only
 * disagreed later, under load, in whichever request first touched the missing column.
 *
 * DRIFT CHECK ONLY. It never runs a migration. A migration failing part way with a deploy in flight
 * is a worse failure than the one being closed, and the operator ordering in docs/operations exists
 * because some of these casts are destructive.
 *
 * IT ASSERTS WHICH DATABASE IT IS TALKING TO, FIRST, AND REFUSES ON MISMATCH (DEC-0207). Everything
 * below that assertion is only meaningful once the subject is known: a per-row comparison against
 * the wrong database is not a weaker check, it is a confident wrong answer. Railway production's
 * migration credential named and hosted staging while every layer of the gate agreed with it,
 * which is exactly the case a name-trusting check cannot see.
 *
 * BLOCKING, NOT WARNING. This register's history is that warnings read as green.
 */

import postgres from "postgres";
import { CANONICAL_DATABASE_NAME, type DeployEnvironment } from "@/config/env-shape";
import {
  compareAppliedToJournal,
  readJournalMigrations,
  type AppliedMigration,
} from "@/server/db/schema-drift";
import { resolveDatabaseSslOption } from "@/server/db/ssl-options";
import {
  ENV_PATH_FLAG,
  assertEnvFileLoaded,
  describeEnvFileLoad,
  hasFlag,
  loadEnvFile,
  readFlagValue,
} from "@/server/scripts/env-file";

const DRIZZLE_DIR = "drizzle";

const argv = process.argv.slice(2);

/**
 * A failed check, already reported. Distinguished from an unexpected throw so `main`'s catch does
 * not print a second, differently worded line over a message that was written for the deploy log.
 */
class CheckFailed extends Error {}

/**
 * Reports the failure and unwinds. It THROWS rather than calling `process.exit`, which returns
 * `never` by terminating and so skips the `finally` that closes the database connection — the
 * teardown guarantee Rule 35 asks of anything that opens one.
 */
const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  throw new CheckFailed(message);
};

/**
 * Which environment to hold the database to.
 *
 * Taken from an explicit argument rather than from APP_ENV: this runs as a CI step rather than
 * inside the app, and reading an ambient variable is how a production run quietly checks itself
 * against preview's expectations.
 */
const requestedEnvironment = (): DeployEnvironment => {
  const raw = readFlagValue(argv, "--environment") ?? argv[0] ?? "";

  if (raw === "production" || raw === "preview") {
    return raw;
  }

  return fail(
    `Pass the environment to check: "production" or "preview" (got ${JSON.stringify(raw)}). ` +
      "It is required rather than inferred, so a production run cannot silently assert preview's " +
      "expectations.",
  );
};

const main = async (): Promise<void> => {
  const environment = requestedEnvironment();

  // Same pulled file the other two gate layers read, and the same anti-silent-no-op guard: without
  // --require-env-file a moved file would leave this checking an empty environment and reporting
  // whatever that produced.
  const load = loadEnvFile({
    environment,
    explicitPath: readFlagValue(argv, ENV_PATH_FLAG),
  });

  console.log(describeEnvFileLoad(load));

  if (hasFlag(argv, "--require-env-file")) {
    assertEnvFileLoaded(load);
  }

  const expectedDatabase = CANONICAL_DATABASE_NAME[environment];
  const url = process.env.MIGRATION_DATABASE_URL;

  if (!url) {
    fail("MIGRATION_DATABASE_URL is not set, so there is no schema to compare.");
    return;
  }

  const journal = readJournalMigrations(DRIZZLE_DIR);
  const ssl = resolveDatabaseSslOption();
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  try {
    const [identity] = await sql<{ db: string; usr: string }[]>`
      select current_database() as db, current_user as usr
    `;

    if (!identity) {
      fail("Connected but the server returned no identity row.");
      return;
    }

    // THE ASSERTION THIS CHECK IS BUILT AROUND. Answered by the server, so the connection string
    // cannot talk its way past it.
    if (identity.db !== expectedDatabase) {
      fail(
        `Connected to database "${identity.db}" as "${identity.usr}", but ${environment} must be ` +
          `checked against "${expectedDatabase}". Refusing to report on a database this is not ` +
          "for. Fix MIGRATION_DATABASE_URL rather than this check.",
      );
      return;
    }

    console.log(
      `Subject: database "${identity.db}" as "${identity.usr}" (${environment}), ` +
        `${journal.length} migrations declared in ${DRIZZLE_DIR}/meta/_journal.json.`,
    );

    const rows = await sql<{ hash: string; created_at: string }[]>`
      select hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at asc, id asc
    `;

    const applied: AppliedMigration[] = rows.map((row) => ({
      hash: row.hash,
      createdAtMillis: Number(row.created_at),
    }));

    const problems = compareAppliedToJournal(journal, applied);

    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(
          `  drift at index ${problem.index}` +
            `${problem.tag ? ` (${problem.tag})` : ""}: ${problem.problem}`,
        );
      }
      fail(
        `${problems.length} migration(s) differ between "${identity.db}" and this checkout. ` +
          "Deploying a checkout whose schema history the database does not share is what this " +
          "gate exists to stop.",
      );
      return;
    }

    console.log(
      `PASS: all ${journal.length} migrations match row for row, by SHA-256 of each .sql file.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
};

// Message only, no stack: every throw on this path is an operational message written for whoever
// is reading a failed deploy log, and a stack trace buries it.
main().catch((error: unknown) => {
  if (!(error instanceof CheckFailed)) {
    console.error(
      `\nSchema drift check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.exitCode = 1;
});
