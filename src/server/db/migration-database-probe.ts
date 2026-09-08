/**
 * Whether MIGRATION_DATABASE_URL reaches the database its environment is supposed to migrate.
 *
 * THIS PROBE EXISTS BECAUSE THE SHAPE CHECK CANNOT FAIL ON THE FAULT THAT HAPPENED. Railway
 * production's migration credential pointed at `lombakita_staging`, on a different Neon endpoint
 * from production's, and every layer of the deploy gate was content: the variable was present, it
 * parsed as a Postgres URL, and no check asked the server what it had connected to. A migration run
 * from that process would have applied to staging while reporting success.
 *
 * So this asks the server. `current_database()` is answered by the database itself and cannot be
 * spoofed by the string used to reach it, which is the whole point of asserting it in band
 * (DEC-0207). The expected name comes from `CANONICAL_DATABASE_NAME`, declared beside the rest of
 * the deployment's stated identity, so the two sides of the comparison have independent origins.
 *
 * It opens its OWN short-lived client rather than reusing `getSqlClient()`: that one is built from
 * DATABASE_URL and is the app's pooled connection, and a probe of a different credential that
 * borrowed it would be measuring the wrong string entirely. `max: 1` and a hard close, because this
 * runs once in CI and must not leave a connection behind.
 */

import postgres from "postgres";
import { serverEnv } from "@/config/env.server";
import { CANONICAL_DATABASE_NAME, type DeployEnvironment } from "@/config/env-shape";

export const isMigrationDatabaseConfigured = (): boolean => {
  return Boolean(process.env.MIGRATION_DATABASE_URL);
};

/**
 * The deployed environment this process belongs to, or null when it is neither.
 *
 * Local and test runs have no canonical database to be checked against, so the probe reports itself
 * unconfigured there rather than inventing an expectation.
 */
export const deployEnvironmentOf = (appEnv: string): DeployEnvironment | null => {
  if (appEnv === "production") return "production";
  if (appEnv === "preview" || appEnv === "staging") return "preview";

  return null;
};

export const probeMigrationDatabase = async (): Promise<void> => {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error("MIGRATION_DATABASE_URL is not configured");
  }

  const environment = deployEnvironmentOf(serverEnv.appEnv);
  if (!environment) {
    throw new Error(
      `APP_ENV "${serverEnv.appEnv}" names no deployed environment, so there is no canonical ` +
        "database to check the migration credential against",
    );
  }

  const expected = CANONICAL_DATABASE_NAME[environment];
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    prepare: false,
    ssl: "require",
  });

  try {
    const [row] = await sql<{ db: string; usr: string }[]>`
      select current_database() as db, current_user as usr
    `;

    if (!row) {
      throw new Error("MIGRATION_DATABASE_URL connected but returned no identity row");
    }

    if (row.db !== expected) {
      throw new Error(
        `MIGRATION_DATABASE_URL reaches database "${row.db}" as "${row.usr}", but ${environment} ` +
          `must migrate "${expected}". A migration run here would apply to the wrong database.`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
};
