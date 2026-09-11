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

import { isLoopbackUrl, parseDatabaseHost } from "../../lib/loopback-host.mjs";

/** The marker whose survival IS the measurement in the database-side probes. */
export const MARKER_TABLE = "reset_probe_marker";

/**
 * Every database this harness is allowed to create and destroy, named in one place.
 *
 * DERIVED, NOT RESTATED. The probe suites read these keys instead of writing the names as literals,
 * so a suite cannot reach a database the guard below has never heard of, and adding a probe means
 * adding its throwaway here rather than discovering later that the allow-list lags the suites.
 * Same construction as `PROTECTED_DATABASE_NAMES` deriving from `CANONICAL_DATABASE_NAME`.
 */
export const PROBE_DATABASES = Object.freeze({
  /** A protected name, so the reset guard's identity layer is the thing that has to refuse. */
  protectedTarget: "lombakita_production",
  /** A name nothing protects, so the environment layer is the only thing that can refuse. */
  unprotectedTarget: "lombakita_disposable",
  /** Reached through a non-loopback address, so the host layer is the only thing that can refuse. */
  hostProbeTarget: "lombakita_hostprobe",
  /** Watched by the harness probes to see whether this guard let it be dropped. */
  harnessWitness: "lombakita_loopback_witness",
});

const PROBE_DATABASE_NAMES = Object.freeze(Object.values(PROBE_DATABASES));

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

/**
 * Refuses to destroy anything that is not one of this harness's own throwaways on this machine.
 *
 * THIS GUARD EXISTS BECAUSE THE HARNESS WAS THE MOST DANGEROUS CODE IN THE STEP. It issues
 * `DROP DATABASE ... WITH (FORCE)`, which terminates live sessions first, against a name that is
 * deliberately `lombakita_production` (the reset guard's identity layer can only be the thing that
 * refuses if the target carries a protected name). It read `MIGRATION_DATABASE_URL ?? DATABASE_URL`
 * and asked nothing else. A shell with a staging `MIGRATION_DATABASE_URL` exported, which is how
 * `verify:schema-drift` and `connectors:status:live` are run, was one command away from a forced
 * drop against that server. The reset path it exists to prove safe was guarded three ways; this was
 * guarded none.
 *
 * TWO REFUSALS, and they do different jobs. The allow-list is the stronger: a loopback check alone
 * still permits the harness to be aimed at a real database that happens to be reachable on
 * localhost, which is exactly what an `ssh -L 5432:prod:5432` tunnel produces. The host check
 * catches the case the allow-list cannot see, a throwaway NAME on a server that is not this one.
 *
 * `assertPlainIdentifier` is not a third layer. It refuses DDL injection and accepts
 * `lombakita_production`, `postgres` and `template1` quite happily, which is correct for what it is
 * and useless as an identity check.
 *
 * Deliberately a separate statement the callers make rather than something threaded through
 * `baseDatabaseUrl`'s return value: this is a guard that must be shown refusing BEFORE the drop,
 * and a guard whose relocation cannot be expressed cannot be probed for ordering.
 */
const assertProbeTargetIsDisposable = (databaseName) => {
  assertPlainIdentifier(databaseName);

  if (!PROBE_DATABASE_NAMES.includes(databaseName)) {
    throw new Error(
      `refusing to destroy "${databaseName}": this harness may only create and drop its own ` +
        `throwaways (${PROBE_DATABASE_NAMES.join(", ")}). Add it to PROBE_DATABASES if a probe ` +
        "genuinely needs it.",
    );
  }

  const url = baseDatabaseUrl();

  if (!isLoopbackUrl(url)) {
    throw new Error(
      `refusing to destroy "${databaseName}" on "${parseDatabaseHost(url) ?? "<unparseable>"}": ` +
        "these probes drop databases outright, so they run against loopback and nothing else. " +
        "Unset MIGRATION_DATABASE_URL and DATABASE_URL, or point them at your own Postgres.",
    );
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
  assertProbeTargetIsDisposable(databaseName);

  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await sql.unsafe(`create database ${databaseName}`);
  });

  await onDatabase(databaseName, async (sql) => {
    await sql.unsafe(`create table ${MARKER_TABLE} (id integer)`);
  });
};

export const dropProbeDatabase = async (databaseName) => {
  assertProbeTargetIsDisposable(databaseName);

  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
  });
};

export const markerSurvives = async (databaseName) =>
  onDatabase(databaseName, async (sql) => {
    const [row] = await sql`select to_regclass(${`public.${MARKER_TABLE}`}) is not null as present`;

    return row.present === true;
  });
