/*
 * Rule 36 probes for the matrix seed's in-band refusal.
 *
 * The seed writes real accounts with a published password into whatever database its connection
 * string reaches. Its module-scope check reads that string, and a string that says "localhost" is
 * satisfied by any localhost-terminated tunnel. The in-band check asks the server which database it
 * is, and it is the only one of the two that cannot be lied to. This file shows that check is
 * load-bearing, in both directions Rule 32 asks for: removed, and moved below the first write.
 *
 * CLASS B: a guard before a series of writes with no transaction around them, so nothing rolls
 * back and the detector must be the POST-STATE. Every run here that keeps the guard anywhere ends
 * in the same thrown refusal, naming the same database, exiting non-zero, whether the guard ran
 * before the users were written or after. Only the database knows which. So each probe migrates a
 * throwaway that carries a PROTECTED NAME, points the real `npm run db:seed` at it, and asks
 * afterwards whether `seed-user-%` rows exist. Guarded, none do. Unguarded or late, they do.
 *
 * Usage: node scripts/testing/probes/seed-guard.mjs
 * Requires a reachable local Postgres whose role may CREATE DATABASE.
 * Runs only over committed work; the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import {
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  onDatabase,
  withDatabase,
} from "./throwaway-database.mjs";

const SEED = "scripts/seed-test-matrix.ts";

/** Printed by the seed once it is past the guard's position and about to write. */
const REACHED_THE_WRITES = "writing the matrix";

/** Printed by the guard when it refuses, wherever it sits. */
const THE_GUARD_REFUSED = "refusing to reset";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

/**
 * Migrates the throwaway so the seed has tables to write into.
 *
 * The migration guard refuses only under APP_ENV=production, so a locally-named protected database
 * migrates like any other; it is the seed's identity layer, not the migrator's, under test here.
 */
const migrate = (childUrl) => {
  const result = spawnSync("npm", ["run", "db:migrate:guarded"], {
    encoding: "utf8",
    env: { ...process.env, MIGRATION_DATABASE_URL: childUrl, DATABASE_URL: childUrl },
  });

  if (result.status !== 0) {
    throw new Error(
      "could not migrate the probe database, so the seed would have had nothing to write into " +
        `and the post-state would prove nothing:\n${(result.stdout ?? "") + (result.stderr ?? "")}`.slice(-1200),
    );
  }
};

const seedRowsWritten = async (databaseName) =>
  onDatabase(databaseName, async (sql) => {
    const [row] = await sql`select count(*)::int as n from users where id like 'seed-user-%'`;

    return row.n > 0;
  });

/**
 * Runs the real seed against a throwaway carrying a protected name and reports whether it wrote.
 *
 * Teardown is in a `finally` (Rule 35): the database is dropped whether the assertion passed,
 * failed, or threw.
 */
const seedWroteInto = async (databaseName) => {
  const childUrl = withDatabase(baseDatabaseUrl(), databaseName);

  await createProbeDatabase(databaseName);

  try {
    migrate(childUrl);

    const result = spawnSync("npm", ["run", "db:seed"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: childUrl, MIGRATION_DATABASE_URL: "" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // CLAUSE 3, reached. A run that never got as far as the writes has not measured whether the
    // guard stopped them; it died of something else, and that must not be read as the guard
    // holding. The refusal firing is accepted as reached too: a guard that fired AFTER writing is
    // exactly the case the moved probe exists to catch, and the post-state decides it.
    if (!output.includes(REACHED_THE_WRITES) && !output.includes(THE_GUARD_REFUSED)) {
      throw new Error(
        `the seed neither reached its writes nor refused, so nothing was measured. Tail of its ` +
          `output:\n${output.slice(-800)}`,
      );
    }

    const wrote = await seedRowsWritten(databaseName);

    return {
      refused: wrote,
      evidence: wrote
        ? `seed-user-% rows EXIST in "${databaseName}": the seed wrote into a protected database`
        : `no seed-user-% row in "${databaseName}": the guard refused before the first write`,
    };
  } finally {
    await dropProbeDatabase(databaseName);
  }
};

/** The exact call the seed makes, matched as one unit so a move takes the whole thing. */
const GUARD_CALL = "    await assertSeedTargetIsDisposable(sql, databaseUrl);\n";

/** The first write the guard exists to stop: the end of the users loop. */
const AFTER_THE_USERS_LOOP =
  "        ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()\n" +
  "      `;\n" +
  "    }\n";

export const probes = [
  {
    name: "the seed refuses a protected database — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so a seed pointed through a tunnel at production writes eleven accounts with a published password",
    files: [SEED],
    appliedMarkers: ["// probe: disposability check removed"],
    mutate: () => substituteOnce(SEED, GUARD_CALL, "    // probe: disposability check removed\n"),
    detect: async () => seedWroteInto(PROBE_DATABASES.protectedTarget),
  },
  {
    name: "the seed refuses BEFORE writing anything — GUARD MOVED",
    // The refusal still fires, still names the right database, and still exits non-zero after the
    // move: every signal a detector could read off the output is identical. Only the database
    // differs, which is why the post-state is the only honest detector here.
    klass: "B",
    harmfulMove:
      "checking after the users are written, so the run refuses having already created the accounts the refusal was for",
    files: [SEED],
    appliedMarkers: ["// probe: disposability check moved below the users loop"],
    mutate: () => {
      substituteOnce(SEED, GUARD_CALL, "");
      substituteOnce(
        SEED,
        AFTER_THE_USERS_LOOP,
        AFTER_THE_USERS_LOOP +
          "    // probe: disposability check moved below the users loop\n" +
          GUARD_CALL,
      );
    },
    detect: async () => seedWroteInto(PROBE_DATABASES.protectedTarget),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe set
// without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
