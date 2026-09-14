/**
 * Shows that the reset's index rebuild can now FAIL, which is the thing it could not do before.
 *
 * THE DEFECT THIS MEASURES IS AN INSTRUMENT THAT CANNOT GO RED. `npm run db:reset` used to drop the
 * database at step 2 and rebuild the search index at step 5, so the rebuild always ran against zero
 * rows, always asserted `0 == 0`, and always printed four ticks. Nothing was wrong with the
 * assertion. It was correct and it was vacuous, and those look identical in a terminal.
 *
 * Seeding between the ledger check and the rebuild is what gives the assertion a subject. But
 * moving the seed does not by itself prove the assertion is live: a reindex that still could not
 * fail would go on printing the same ticks over a populated database, and read as MORE convincing
 * rather than less. So the claim under test is not "the index holds 15 documents". It is "a run
 * that should have found rows and found none is refused".
 *
 * CLASS D (Rule 36): the guard is a read-path refusal with no write to reorder, so the detector is
 * result content. Two runs against the same freshly created, EMPTY database, differing only in the
 * flag the reset passes:
 *   - without `--expect-populated`, zero rows is a legitimate answer and the run succeeds;
 *   - with it, the run is refused and says so.
 * The control matters as much as the probe. A refusal that fired in both directions would mean the
 * script had simply stopped working against empty databases, which would break every developer with
 * no competitions rather than catch a seed that failed to land.
 *
 * CLAUSE 3 (reached): each run must be shown to have got as far as querying the database. A run
 * that died at the guard, at the Meilisearch connection or at env resolution has measured nothing,
 * and must not be read as either outcome.
 */

import { spawnSync } from "node:child_process";

import {
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  withDatabase,
} from "./throwaway-database.mjs";

/** The step whose output proves the run reached the database rather than dying before it. */
const REACHED_THE_REBUILD = "[4/4] Rebuilding from the database";

// The unprotected name, so the reindex's own disposability guard permits the run and the flag is
// the only thing that differs between the control and the probe. A protected name would refuse both
// and the comparison would measure the guard instead.
const PROBE_DATABASE = PROBE_DATABASES.unprotectedTarget;

/** Runs the real reindex against an empty database, with and without the flag. */
const reindexAgainstEmpty = ({ expectPopulated }) => {
  const url = withDatabase(baseDatabaseUrl(), PROBE_DATABASE);

  const result = spawnSync(
    "npm",
    ["run", "search:reindex", ...(expectPopulated ? ["--", "--expect-populated"] : [])],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
    },
  );

  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
};

const main = async () => {
  await createProbeDatabase(PROBE_DATABASE);

  // The probe database is created empty and never migrated, so the rebuild's query has to fail on a
  // missing table rather than return zero rows. Migrate it first, or the two runs differ for a
  // reason that has nothing to do with the flag.
  const url = withDatabase(baseDatabaseUrl(), PROBE_DATABASE);
  const migrated = spawnSync("npm", ["run", "db:migrate:guarded"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
  });

  if (migrated.status !== 0) {
    await dropProbeDatabase(PROBE_DATABASE);
    throw new Error(
      `could not migrate the probe database, so neither run would have measured the flag:\n${
        (migrated.stdout ?? "") + (migrated.stderr ?? "")
      }`,
    );
  }

  try {
    const control = reindexAgainstEmpty({ expectPopulated: false });
    const probe = reindexAgainstEmpty({ expectPopulated: true });

    for (const [label, run] of [
      ["control", control],
      ["probe", probe],
    ]) {
      if (!run.output.includes(REACHED_THE_REBUILD)) {
        throw new Error(
          `the ${label} run never reached the rebuild, so nothing was measured. Tail:\n` +
            run.output.slice(-800),
        );
      }
    }

    const controlPassed = control.status === 0;
    const probeRefused = probe.status !== 0 && probe.output.includes("told to expect some");

    console.log(
      `control (no flag, empty database): ${controlPassed ? "SUCCEEDED" : "failed"}; ` +
        "zero published competitions is a legitimate answer and must not be an error",
    );
    console.log(
      `probe   (--expect-populated, empty database): ${probeRefused ? "REFUSED" : "did not refuse"}; ` +
        "the assertion the reset relies on is capable of going red",
    );

    if (!controlPassed || !probeRefused) {
      throw new Error(
        "the flag did not change the outcome. Either the reindex refuses empty databases in both " +
          "directions (which breaks every machine with no competitions), or it refuses in " +
          "neither, in which case the reset's step 6 is still an assertion that cannot fail.",
      );
    }

    console.log("\n✓ step 6's assertion measures something it did not measure before.\n");
  } finally {
    await dropProbeDatabase(PROBE_DATABASE);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
