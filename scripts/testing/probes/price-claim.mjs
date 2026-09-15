/*
 * Rule 36 probes for the matrix seed's price-claim check.
 *
 * THE DEFECT THIS MEASURES IS A FIXTURE WHOSE COPY AND DATA DISAGREE, AND A DATABASE THAT DESCRIBES
 * A LANE IT DOES NOT CONTAIN. Three fixtures' descriptions call themselves paid. Their prices were
 * written by the opt-in money lane, so `npm run db:reset` — the shape CI runs — left all three
 * holding `fee_amount` NULL while their copy went on saying `berbayar`. The manual bukti-transfer
 * lane was unreachable against every one of them, and the instrument that noticed was a harness
 * reporting twelve surfaces as product defects.
 *
 * The repair prices the fixture where it is declared, and the check refuses a seeded competition
 * whose copy and price disagree. WHAT THIS FILE HAS TO SHOW IS THAT THE CHECK IS NOT THE FOURTH
 * VACUOUS INSTRUMENT OF THE PHASE: that it refuses, that deleting it lets the lie through, and that
 * moving it above the write it checks makes it report success over the very database it exists to
 * refuse.
 *
 * THREE PROBES OVER ONE BROKEN PREMISE. All three strip `seed-comp-paid`'s price declaration, which
 * is the disagreement itself; they differ only in what they do to the check.
 *
 *   1. PREMISE BROKEN — the check left alone. It must REFUSE, naming the fixture.
 *   2. GUARD REMOVED  — the call deleted. The run must succeed and the lie must persist.
 *   3. GUARD MOVED    — the call moved above the competition write. It must RUN, report success,
 *                       and the lie must persist anyway.
 *
 * THE FIRST PROBE'S `refused` MEANS THE OPPOSITE OF THE OTHER TWO, and that is deliberate.
 * `runProbe` reports RED when a probe's own claim was demonstrated, and its suite refuses to pass
 * unless every probe is red. Probes 2 and 3 claim that the check's absence lets the lie through;
 * probe 1 claims that the check refuses. Without probe 1 the suite has a hole a dead check would
 * fall straight through: a check that returned early would still leave probes 2 and 3 red, because
 * removing something that does nothing changes nothing. Probe 1 is the only one that observes the
 * check working, and it is why it runs through the harness rather than beside it.
 *
 * CLASS B (Rule 36). No transaction wraps the seed's writes, so nothing rolls back and the question
 * is the POST-STATE: does the throwaway hold a seeded competition whose copy and price disagree.
 * The detector reads that off the database and never off the run's exit status alone.
 *
 * RULE 35. Each measurement creates a throwaway, migrates it, seeds it and drops it. The drop is in
 * a `finally` inside the measurement — not around the suite, because `runProbes` calls
 * `process.exit` and a teardown there would be skipped by exactly the failure it exists for.
 *
 * Usage: npm run verify:price-claim-probe
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { readFile, runProbes, substituteOnce } from "../guard-probe.mjs";
import {
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  migrateProbeDatabase,
  onDatabase,
  withDatabase,
} from "./throwaway-database.mjs";

const SEED = "scripts/seed-test-matrix.ts";

/** The fixture whose copy calls itself paid: the one the check exists to catch. */
const PRICED_FIXTURE_WITH_A_CLAIM = "seed-comp-paid";

/**
 * The fixture's price declaration, matched with its indentation and newline so the removal takes
 * the whole statement rather than leaving a blank line where a property used to be.
 */
const PRICE_DECLARATION = "        feeAmount: 150000,\n";
const PRICE_DECLARATION_REMOVED = "        // probe: the fixture's price declaration removed\n";

/** The check's call as it stands on disk, matched as one unit so a move takes the whole thing. */
const GUARD_CALL = "    await assertSeededPricesMatchDescriptions(sql);\n";
const GUARD_CALL_REMOVED = "    // probe: the price-claim check removed\n";
const GUARD_CALL_MOVED = "    // probe: the price-claim check moved above the write it checks\n";

/** The write the check exists to be after, and the position that makes it vacuous. */
const COMPETITIONS_WRITE = "    for (const c of comps) {\n";

/** Printed by the seed once it is past every write, so a run carrying it reached the check. */
const REACHED_THE_END = "Seed complete.";

/**
 * Printed by the check itself when it finds nothing to object to.
 *
 * This is what separates the moved probe from the removed one: a removed check prints nothing, a
 * moved check prints this over a database that holds the disagreement.
 */
const GUARD_REPORTED_SUCCESS = /every seeded competition whose copy claims a price/;

/** The check's own refusal, quoted so the detector names what it observed. */
const REFUSAL_NAMING_THE_FIXTURE = `${PRICED_FIXTURE_WITH_A_CLAIM} says it is paid but carries no price`;

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

/**
 * The word the check reads a fixture's copy for, taken from the check rather than retyped.
 *
 * A probe that spells the population's own predicate a second time drifts from it silently: the
 * check would go on refusing `berbayar` while the post-state read looked for something else, and
 * the disagreement would be reported as absent. Reading it refuses instead — the pattern not
 * matching is a throw, not a verdict.
 */
const paidClaimWord = () => {
  const declared = /const PAID_CLAIM_WORD = "([^"]+)";/.exec(readFile(SEED));

  if (!declared) {
    throw new Error(
      `${SEED} no longer declares the word a fixture's copy is read for, so this probe cannot say ` +
        "which rows the check's population covers. Point it at the declaration again.",
    );
  }

  return declared[1];
};

/**
 * Every seeded competition in the throwaway whose copy and price disagree, asked as the check asks.
 *
 * The post-state, and the only honest detector for a guard with no transaction around it. Read
 * from the database rather than inferred from the run: a run that refused and a run that wrote the
 * same lie differ only here.
 */
const seededCompetitionsWhoseCopyAndPriceDisagree = async (databaseName) => {
  const word = paidClaimWord();

  return onDatabase(databaseName, async (sql) => {
    const rows = await sql`
      SELECT id FROM competitions
      WHERE id LIKE 'seed-comp-%'
        AND description LIKE ${`%${word}%`}
          <> (fee_amount IS NOT NULL AND fee_amount > 0)
      ORDER BY id
    `;

    return rows.map((row) => row.id);
  });
};

/**
 * Seeds a throwaway and reports what it said and what the database holds afterwards.
 *
 * CLAUSE 3. A run that neither finished nor refused over the fixture died of something else — a
 * migration the seed could not use, a connection it could not make — and must not be read as
 * either outcome. The refusal is accepted as reached too: it is printed by the check itself, so a
 * run carrying it has demonstrably reached the check.
 */
const seedAgainstAThrowaway = async (databaseName) => {
  const childUrl = withDatabase(baseDatabaseUrl(), databaseName);

  await createProbeDatabase(databaseName);

  try {
    migrateProbeDatabase(childUrl);

    const result = spawnSync("npm", ["run", "db:seed"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: childUrl, MIGRATION_DATABASE_URL: "" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    if (!output.includes(REACHED_THE_END) && !output.includes(REFUSAL_NAMING_THE_FIXTURE)) {
      throw new Error(
        "the seed neither finished nor refused over the fixture, so nothing was measured. Tail of " +
          `its output:\n${output.slice(-800)}`,
      );
    }

    return {
      output,
      status: result.status,
      disagreeing: await seededCompetitionsWhoseCopyAndPriceDisagree(databaseName),
    };
  } finally {
    await dropProbeDatabase(databaseName);
  }
};

/**
 * Refuses a run that reported the fixtures sound, whatever its exit status.
 *
 * The mutation's whole job is to create the disagreement, and a check that PASSED over it means the
 * mutation landed without breaking the premise — clause 3's "a mutation that lands but leaves the
 * asserted property intact is not a probe". Thrown rather than returned, so it cannot be read as
 * either verdict.
 */
const refuseIfTheCheckReportedSuccess = (run, probe) => {
  if (GUARD_REPORTED_SUCCESS.test(run.output)) {
    throw new Error(
      `${probe}: the check PASSED over the disagreement this mutation exists to create, so the ` +
        "premise was not broken and this run measured nothing.",
    );
  }
};

export const probes = [
  {
    name: "a fixture whose copy calls itself paid and whose row carries no price is refused — PREMISE BROKEN",
    klass: "B",
    harmfulMove:
      "seeding a competition whose copy tells every reader it is paid while the row carries no " +
      "price, so each instrument calibrated on that fixture describes a money lane the database " +
      "does not contain",
    files: [SEED],
    appliedMarkers: [PRICE_DECLARATION_REMOVED],
    mutate: () => substituteOnce(SEED, PRICE_DECLARATION, PRICE_DECLARATION_REMOVED),
    detect: async () => {
      const run = await seedAgainstAThrowaway(PROBE_DATABASES.priceClaimPremise);

      refuseIfTheCheckReportedSuccess(run, "PREMISE BROKEN");

      const refusedNamingTheFixture = run.output.includes(REFUSAL_NAMING_THE_FIXTURE);

      return {
        refused: run.status !== 0 && refusedNamingTheFixture,
        evidence:
          `exit ${run.status}, the check refused naming \`${REFUSAL_NAMING_THE_FIXTURE}\`; the ` +
          `throwaway holds ${run.disagreeing.length} disagreeing row(s) ` +
          `(${run.disagreeing.join(", ") || "none"}) — the check runs after the seed's writes and ` +
          "reports the state rather than rolling it back",
      };
    },
  },
  {
    name: "the lie is written and nothing objects — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so a fixture that describes a paid competition it does not create is " +
      "seeded without a word and the next reader of that database is told about a lane that is not in it",
    files: [SEED],
    appliedMarkers: [PRICE_DECLARATION_REMOVED, GUARD_CALL_REMOVED],
    mutate: () => {
      substituteOnce(SEED, PRICE_DECLARATION, PRICE_DECLARATION_REMOVED);
      substituteOnce(SEED, GUARD_CALL, GUARD_CALL_REMOVED);
    },
    detect: async () => {
      const run = await seedAgainstAThrowaway(PROBE_DATABASES.priceClaimRemoved);

      // The removal has to be shown to have removed something. A check that still ran would make
      // this measurement a second copy of the premise probe, whatever the post-state says.
      if (GUARD_REPORTED_SUCCESS.test(run.output)) {
        throw new Error(
          "the check ran even though its call was deleted, so the call is not what was holding.",
        );
      }

      const reportedSuccess = run.status === 0;
      const theLiePersists = run.disagreeing.includes(PRICED_FIXTURE_WITH_A_CLAIM);

      if (reportedSuccess && !theLiePersists) {
        throw new Error(
          "the seed reported success and the throwaway holds no disagreement, so the mutation did " +
            "not create one and this run measured nothing.",
        );
      }

      return {
        refused: reportedSuccess && theLiePersists,
        evidence:
          `exit ${run.status}, the check never ran, and the throwaway holds ` +
          `${run.disagreeing.join(", ") || "no disagreeing row"} — a database that calls a ` +
          "competition paid and holds no price for it",
      };
    },
  },
  {
    name: "the check reports success over the database it exists to refuse — GUARD MOVED",
    klass: "B",
    harmfulMove:
      "checking before the competitions are written, so the run inspects a table this seed has not " +
      "filled yet, prints that every price and description agree, and then writes the disagreement",
    files: [SEED],
    appliedMarkers: [PRICE_DECLARATION_REMOVED, GUARD_CALL_MOVED],
    mutate: () => {
      substituteOnce(SEED, PRICE_DECLARATION, PRICE_DECLARATION_REMOVED);
      substituteOnce(SEED, GUARD_CALL, "");
      substituteOnce(SEED, COMPETITIONS_WRITE, GUARD_CALL_MOVED + GUARD_CALL + COMPETITIONS_WRITE);
    },
    detect: async () => {
      const run = await seedAgainstAThrowaway(PROBE_DATABASES.priceClaimMoved);

      // THE MOVE HAS TO BE SHOWN TO BE A MOVE. Without this the probe could not tell its own
      // mutation from the removal probe's, and a check that never ran at its new position would be
      // a deletion wearing a relocation's diff.
      if (!GUARD_REPORTED_SUCCESS.test(run.output)) {
        throw new Error(
          "the check did not run at its moved position, so this measures a removal rather than a " +
            "move and says nothing about ordering.",
        );
      }

      const reportedSuccess = run.status === 0;
      const theLiePersists = run.disagreeing.includes(PRICED_FIXTURE_WITH_A_CLAIM);

      if (reportedSuccess && !theLiePersists) {
        throw new Error(
          "the seed reported success and the throwaway holds no disagreement, so the mutation did " +
            "not create one and this run measured nothing.",
        );
      }

      return {
        refused: reportedSuccess && theLiePersists,
        evidence:
          `exit ${run.status}, the check RAN, reported that every price and description agree, and ` +
          `the throwaway holds ${run.disagreeing.join(", ") || "no disagreeing row"} — the guard ` +
          "earned its ✓ over a database it had not looked at yet",
      };
    },
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe set
// without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
