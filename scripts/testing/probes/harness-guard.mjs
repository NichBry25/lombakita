/*
 * Rule 36 probes for the probe harness's OWN refusal.
 *
 * A THIRD DESTRUCTIVE SURFACE, and the one that was unguarded. `reset-guard.mjs` and
 * `reindex-guard.mjs` probe guards in front of a schema drop and an index delete. This suite probes
 * the guard in front of `DROP DATABASE ... WITH (FORCE)`, which is the most destructive statement
 * anywhere in this step: it removes an entire database and terminates live sessions to do it.
 *
 * It exists because that statement shipped with no guard at all while the path it was written to
 * prove safe had three. The harness read `MIGRATION_DATABASE_URL ?? DATABASE_URL` and destroyed a
 * database named `lombakita_production` on whatever server that named, which on an ordinary
 * developer's terminal is whatever they last ran `verify:schema-drift` against.
 *
 * CLASS B throughout, post-state, for the same reason as the other two suites: refused and
 * unrefused both end in a throw, so the only honest question is whether the database is still
 * there afterwards.
 *
 * THE DETECTOR DELIBERATELY DOES NOT IMPORT `throwaway-database.mjs`. That module is the one under
 * mutation, and a detector built from the thing it is measuring reports on itself. So the witness
 * databases here are created and inspected through a raw postgres client, and the module under test
 * is reached only in a CHILD process, which loads whatever is on disk at the moment it runs.
 *
 * Usage: node scripts/testing/probes/harness-guard.mjs
 * Requires a reachable local Postgres whose role may CREATE DATABASE.
 * Runs only over committed work: the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import { runProbes, substituteOnce } from "../guard-probe.mjs";

const HARNESS = "scripts/testing/probes/throwaway-database.mjs";

/**
 * A name deliberately ABSENT from `PROBE_DATABASES`.
 *
 * It stands for every database on the operator's server that this harness has no business
 * destroying. The allow-list refusal is the only thing that distinguishes it from a throwaway.
 */
const BYSTANDER = "lombakita_bystander";

/** On the allow-list, so only the loopback refusal can object when it is reached remotely. */
const LOOPBACK_WITNESS = "lombakita_loopback_witness";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

const ambientUrl = () => {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "these probes create and destroy real databases, so DATABASE_URL (or " +
        "MIGRATION_DATABASE_URL) must point at a local Postgres before they can measure anything",
    );
  }

  return url;
};

const withDatabase = (url, databaseName) => {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;

  return parsed.toString();
};

/** The same server at an address `isLoopbackUrl` does not recognise. */
const atNonLoopbackAddress = (url) => {
  const parsed = new URL(url);
  parsed.hostname = "0.0.0.0";

  return parsed.toString();
};

const onMaintenanceDatabase = async (work) => {
  const sql = postgres(withDatabase(ambientUrl(), "postgres"), { max: 1, prepare: false });

  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const createWitness = async (databaseName) =>
  onMaintenanceDatabase(async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await sql.unsafe(`create database ${databaseName}`);
  });

const removeWitness = async (databaseName) =>
  onMaintenanceDatabase(async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
  });

const witnessExists = async (databaseName) =>
  onMaintenanceDatabase(async (sql) => {
    const rows = await sql`select 1 from pg_database where datname = ${databaseName}`;

    return rows.length > 0;
  });

const HARNESS_URL = pathToFileURL(resolve(HARNESS)).href;

/**
 * Calls the harness's own drop in a child process and reports whether the witness survived.
 *
 * Teardown is in a `finally` (Rule 35) and removes the witness whether the assertion passed, failed
 * or threw. It asserts nothing about what it removes because removal is the cleanup, not the
 * measurement; the measurement is taken before it.
 */
const harnessDropped = async (databaseName, { nonLoopback = false } = {}) => {
  const childUrl = nonLoopback ? atNonLoopbackAddress(ambientUrl()) : ambientUrl();

  await createWitness(databaseName);

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { dropProbeDatabase } from ${JSON.stringify(HARNESS_URL)};\n` +
          `await dropProbeDatabase(${JSON.stringify(databaseName)});\n`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: childUrl,
          DATABASE_URL: childUrl,
        },
      },
    );

    const survived = await witnessExists(databaseName);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // CLAUSE 3 — reached. With the mutation applied the child should get past the guard and drop
    // the database. A child that died for some unrelated reason has measured nothing, and must not
    // be read as the guard holding.
    if (survived && result.status !== 0 && !output.includes("refusing to destroy")) {
      throw new Error(
        `the child failed before it could attempt the drop, so nothing was measured. Tail of its ` +
          `output:\n${output.slice(-800)}`,
      );
    }

    return {
      refused: !survived,
      evidence: survived
        ? `database "${databaseName}" survived — the harness refused before dropping it`
        : `database "${databaseName}" is GONE — the harness dropped it`,
    };
  } finally {
    await removeWitness(databaseName);
  }
};

/** The exact call `dropProbeDatabase` makes, anchored to its own function so the match is unique. */
const DROP_GUARD_CALL =
  "export const dropProbeDatabase = async (databaseName) => {\n" +
  "  assertProbeTargetIsDisposable(databaseName);\n";

/** The tail of `dropProbeDatabase`, which no other function in the file shares. */
const DROP_TAIL =
  "    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);\n  });\n};";

export const probes = [
  {
    name: "the harness refuses a database that is not its own throwaway — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so the harness drops whatever database name it is handed on whatever server the environment points at",
    files: [HARNESS],
    appliedMarkers: ["// probe: harness disposability check removed"],
    mutate: () =>
      substituteOnce(
        HARNESS,
        DROP_GUARD_CALL,
        "export const dropProbeDatabase = async (databaseName) => {\n" +
          "  // probe: harness disposability check removed\n",
      ),
    detect: async () => harnessDropped(BYSTANDER),
  },
  {
    name: "the harness refuses BEFORE dropping anything — GUARD MOVED",
    // The ordering claim on this surface. Moved below the drop the refusal still fires and the
    // process still exits non-zero, so every signal readable off the output is identical across the
    // move. Only the database differs, which is why post-state is the only honest detector.
    klass: "B",
    harmfulMove:
      "checking after the drop, so the harness refuses having already destroyed the database the refusal was for",
    files: [HARNESS],
    appliedMarkers: ["// probe: harness disposability check moved below the drop"],
    mutate: () => {
      substituteOnce(
        HARNESS,
        DROP_GUARD_CALL,
        "export const dropProbeDatabase = async (databaseName) => {\n",
      );
      substituteOnce(
        HARNESS,
        DROP_TAIL,
        "    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);\n  });\n\n" +
          "  // probe: harness disposability check moved below the drop\n" +
          "  assertProbeTargetIsDisposable(databaseName);\n};",
      );
    },
    detect: async () => harnessDropped(BYSTANDER),
  },
  {
    name: "the throwaway allow-list is what refuses a database the harness does not own",
    // Neutering this one branch rather than the whole guard. The address is loopback, so the host
    // refusal permits this run; if the bystander is dropped, the allow-list was the only thing
    // standing in the way.
    klass: "B",
    harmfulMove:
      "accepting any name, so a database that merely resembles a throwaway is destroyed alongside them",
    files: [HARNESS],
    appliedMarkers: ["// probe: throwaway allow-list removed"],
    mutate: () =>
      substituteOnce(
        HARNESS,
        "  if (!PROBE_DATABASE_NAMES.includes(databaseName)) {\n",
        "  // probe: throwaway allow-list removed\n" +
          "  if (false && !PROBE_DATABASE_NAMES.includes(databaseName)) {\n",
      ),
    detect: async () => harnessDropped(BYSTANDER),
  },
  {
    name: "the loopback refusal is what refuses a throwaway name on another server",
    // The mirror image: a name the allow-list permits, reached through an address it does not.
    // `0.0.0.0` is the same Postgres as `localhost`, so the database really is destroyed when this
    // branch is gone, without needing a remote server to demonstrate it against.
    klass: "B",
    harmfulMove:
      "dropping a throwaway name on whatever server the ambient environment happens to name, which is how a staging MIGRATION_DATABASE_URL in a shell becomes a forced drop",
    files: [HARNESS],
    appliedMarkers: ["// probe: loopback refusal removed"],
    mutate: () =>
      substituteOnce(
        HARNESS,
        "  if (!isLoopbackUrl(url)) {\n",
        "  // probe: loopback refusal removed\n  if (false && !isLoopbackUrl(url)) {\n",
      ),
    detect: async () => harnessDropped(LOOPBACK_WITNESS, { nonLoopback: true }),
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
