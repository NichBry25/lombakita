/*
 * Rule 36 probes for the from-zero reset path's refusal.
 *
 * The reset drops every table in the database it is pointed at. Nothing undoes that, so the guard
 * in front of it is the only thing standing between a mistyped connection string and the platform's
 * only real accounts. A guard nobody has watched refuse is a guard that has been ASSUMED.
 *
 * CLASS B throughout: a guard before a write, with no transaction around it, so rollback restores
 * nothing and the detector must be the POST-STATE. Reading the error would be worthless here —
 * every one of these runs ends in a thrown refusal whether the guard ran before the drop or after
 * it, and the whole question is which. So each probe creates a real database with a marker table in
 * it, points the real `npm run db:reset` at it, and asks afterwards whether the marker is still
 * there. Guarded, it is. Unguarded, the drop already happened and the refusal came too late to be
 * one.
 *
 * WHAT IS NOT PROBED HERE, stated rather than implied. The connection-host layer's removal has no
 * observable post-state on this machine: with it gone, a remote URL is still refused by the
 * identity layer, and demonstrating otherwise would need a real remote database to destroy. It is
 * covered by `reset-guard.test.ts` and by a live run against a non-loopback host, recorded in the
 * step's review artifact. Rule 36 asks for that to be said rather than for a probe that measures
 * nothing.
 *
 * Usage: node scripts/testing/probes/reset-guard.mjs
 * Requires a reachable local Postgres whose role may CREATE DATABASE.
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { runProbes, substituteOnce } from "../guard-probe.mjs";

const RESET = "scripts/reset/reset-local.ts";
const GUARD = "scripts/reset/reset-guard.ts";

/** The marker whose survival IS the measurement. */
const MARKER_TABLE = "reset_probe_marker";

/** Printed by the reset when it reaches the drop. Its absence means the run measured nothing. */
const REACHED_THE_DROP = "[2/6] Dropping every migrated object";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

const BASE_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!BASE_URL) {
  throw new Error(
    "these probes destroy and rebuild real databases, so DATABASE_URL (or " +
      "MIGRATION_DATABASE_URL) must point at a local Postgres before they can measure anything",
  );
}

/** The same connection string, aimed at a different database on the same server. */
const withDatabase = (url, databaseName) => {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;

  return parsed.toString();
};

/**
 * Refuses a name that is not a bare identifier.
 *
 * These names are literals in this file rather than input, but they are interpolated into DDL that
 * cannot be parameterised, and a probe that could be talked into running arbitrary DDL is not one
 * to leave lying in a repository.
 */
const assertPlainIdentifier = (name) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to interpolate ${JSON.stringify(name)} into DDL`);
  }
};

const onDatabase = async (databaseName, work) => {
  const sql = postgres(withDatabase(BASE_URL, databaseName), { max: 1, prepare: false });

  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/** A database that exists only for one probe, carrying one table whose survival is the verdict. */
const createProbeDatabase = async (databaseName) => {
  assertPlainIdentifier(databaseName);

  // `with (force)` terminates any connection still holding the database open, so a previous
  // interrupted probe cannot leave a name that can never be reused.
  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
    await sql.unsafe(`create database ${databaseName}`);
  });

  await onDatabase(databaseName, async (sql) => {
    await sql.unsafe(`create table ${MARKER_TABLE} (id integer)`);
  });
};

const dropProbeDatabase = async (databaseName) => {
  assertPlainIdentifier(databaseName);

  await onDatabase("postgres", async (sql) => {
    await sql.unsafe(`drop database if exists ${databaseName} with (force)`);
  });
};

const markerSurvives = async (databaseName) =>
  onDatabase(databaseName, async (sql) => {
    const [row] = await sql`select to_regclass(${`public.${MARKER_TABLE}`}) is not null as present`;

    return row.present === true;
  });

/**
 * Runs the real reset against a throwaway database and reports whether the drop happened.
 *
 * MEILISEARCH_HOST and REDIS_URL are blanked for the child on purpose: with the guard removed the
 * reset runs to completion, and the steps after the drop would empty the developer's search index
 * and flush their Redis. The experiment is about the drop; the rest is collateral.
 *
 * Teardown is in a `finally` (Rule 35), and it drops the database whether the assertion passed,
 * failed, or threw.
 */
const dropHappenedAgainst = async (databaseName, environment) => {
  await createProbeDatabase(databaseName);

  try {
    const result = spawnSync("npm", ["run", "db:reset"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: withDatabase(BASE_URL, databaseName),
        DATABASE_URL: withDatabase(BASE_URL, databaseName),
        MEILISEARCH_HOST: "",
        REDIS_URL: "",
        ...environment,
      },
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // CLAUSE 3 — reached. A run that never got as far as attempting the drop has not measured
    // whether the guard stopped it, and must not be read as the guard holding.
    if (!output.includes(REACHED_THE_DROP)) {
      throw new Error(
        `the reset never reached the drop step, so nothing was measured. Tail of its output:\n` +
          output.slice(-800),
      );
    }

    const survived = await markerSurvives(databaseName);

    return {
      refused: !survived,
      evidence: survived
        ? `${MARKER_TABLE} survived in "${databaseName}" — the guard refused before the drop`
        : `${MARKER_TABLE} is GONE from "${databaseName}" — the reset dropped it and refused after`,
    };
  } finally {
    await dropProbeDatabase(databaseName);
  }
};

/** The exact call the reset makes, matched as one unit so a move takes the whole thing. */
const GUARD_CALL =
  "    await assertResetTargetIsDisposable(sql, {\n" +
  "      appEnv,\n" +
  "      databaseUrl: target,\n" +
  "      redisUrl: optionalUrl(process.env.REDIS_URL),\n" +
  "    });\n";

export const probes = [
  {
    name: "the reset refuses a protected database — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so a reset pointed at production drops all 53 tables and reports the failure afterwards",
    files: [RESET],
    appliedMarkers: ["// probe: disposability check removed"],
    mutate: () => substituteOnce(RESET, GUARD_CALL, "    // probe: disposability check removed\n"),
    detect: async () => dropHappenedAgainst("lombakita_production", {}),
  },
  {
    name: "the reset refuses BEFORE dropping anything — GUARD MOVED",
    // THE PROBE THIS STEP OWES. Block B's `checkOptionalBound` sat block-scoped inside an `if`,
    // where relocating it would not compile — so a move test would have passed forever while
    // proving nothing about ordering. This guard takes only `sql` and returns nothing the drop
    // needs, so moving it below the drop compiles and runs. The refusal still fires, still names
    // the right database, and still exits non-zero: every signal a detector could read off the
    // output is identical across the move. Only the database differs, which is why the post-state
    // is the only honest detector here.
    klass: "B",
    harmfulMove:
      "checking after the drop, so the run refuses having already destroyed what the refusal was for",
    files: [RESET],
    appliedMarkers: ["// probe: disposability check moved below the drop"],
    mutate: () => {
      substituteOnce(RESET, GUARD_CALL, "");
      substituteOnce(
        RESET,
        "    await dropEveryMigratedObject(sql);\n",
        "    await dropEveryMigratedObject(sql);\n" +
          "    // probe: disposability check moved below the drop\n" +
          GUARD_CALL,
      );
    },
    detect: async () => dropHappenedAgainst("lombakita_production", {}),
  },
  {
    name: "the database-identity layer is what refuses a protected name",
    // Neutering this one LAYER, rather than the whole guard, is what shows it carries its own
    // weight. The environment and host layers both permit this run — APP_ENV is local and the
    // server is loopback — so if the drop happens, the only thing that was stopping it was the name
    // the SERVER reported.
    klass: "B",
    harmfulMove:
      "trusting the connection string's own name instead of the server's, which is LAUNCH-D24 exactly",
    files: [GUARD],
    appliedMarkers: ["// probe: protected-name refusal removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
        "  // probe: protected-name refusal removed\n  return null;\n  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
      ),
    detect: async () => dropHappenedAgainst("lombakita_production", {}),
  },
  {
    name: "the environment layer is what refuses a production process",
    // The mirror image: a database name nothing protects, reached from a process that believes it
    // is production. Only the environment layer objects, so the drop happening means it was the
    // one holding the line. This is the case a name-based check alone cannot see — a production
    // deployment whose database is not called what the deploy gate expects.
    klass: "B",
    harmfulMove:
      "permitting any environment, so a production process resets whichever database it is pointed at",
    files: [GUARD],
    appliedMarkers: ["// probe: environment allow-list removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {\n    return null;\n  }",
        "  // probe: environment allow-list removed\n  return null;\n  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {\n    return null;\n  }",
      ),
    detect: async () => dropHappenedAgainst("lombakita_disposable", { APP_ENV: "production" }),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe set
// without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
