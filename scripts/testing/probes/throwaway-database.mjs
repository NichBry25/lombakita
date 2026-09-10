/*
 * Throwaway databases for probes that measure a destructive guard.
 *
 * Both reset-path probe suites need the same thing: a real database, named whatever the guard under
 * test is supposed to refuse, that exists for one measurement and is destroyed afterwards whatever
 * happens. Written out twice they drift, and the half that drifts is the teardown — which is the
 * half that leaves a database called `lombakita_production` on someone's machine.
 *
 * Requires a role that may CREATE DATABASE. CI's single `postgres` role is a superuser; a local
 * machine needs `ALTER ROLE <migration role> CREATEDB` once.
 */
import postgres from "postgres";

/** The marker whose survival IS the measurement in the database-side probes. */
export const MARKER_TABLE = "reset_probe_marker";

export const baseDatabaseUrl = () => {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "these probes destroy and rebuild real databases, so DATABASE_URL (or " +
        "MIGRATION_DATABASE_URL) must point at a local Postgres before they can measure anything",
    );
  }

  return url;
};

/** The same connection string, aimed at a different database on the same server. */
export const withDatabase = (url, databaseName) => {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;

  return parsed.toString();
};

/**
 * Refuses a name that is not a bare identifier.
 *
 * These names are literals in the probe files rather than input, but they are interpolated into DDL
 * that cannot be parameterised, and a helper that could be talked into running arbitrary DDL is not
 * one to leave lying in a repository.
 */
const assertPlainIdentifier = (name) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to interpolate ${JSON.stringify(name)} into DDL`);
  }
};

export const onDatabase = async (databaseName, work) => {
  const sql = postgres(withDatabase(baseDatabaseUrl(), databaseName), { max: 1, prepare: false });

  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/**
 * A database that exists only for one probe, carrying one table whose survival is the verdict.
 *
 * `with (force)` terminates any connection still holding the database open, so a previous
 * interrupted probe cannot leave a name that can never be reused.
 */
export const createProbeDatabase = async (databaseName) => {
  assertPlainIdentifier(databaseName);

  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await sql.unsafe(`create database ${databaseName}`);
  });

  await onDatabase(databaseName, async (sql) => {
    await sql.unsafe(`create table ${MARKER_TABLE} (id integer)`);
  });
};

export const dropProbeDatabase = async (databaseName) => {
  assertPlainIdentifier(databaseName);

  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
  });
};

export const markerSurvives = async (databaseName) =>
  onDatabase(databaseName, async (sql) => {
    const [row] = await sql`select to_regclass(${`public.${MARKER_TABLE}`}) is not null as present`;

    return row.present === true;
  });
