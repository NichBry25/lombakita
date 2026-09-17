/*
 * Rule 36 probes for the two things the browser and API harnesses establish before they assert.
 *
 * Both guards exist because their ABSENCE is invisible. Neither is a check on the product; each is a
 * check on whether the harness is in a position to say anything about the product at all, and when
 * one is missing the run still finishes, still prints per-case verdicts, and still reads like a
 * report about the app.
 *
 * ── THE SEED LANES ───────────────────────────────────────────────────────────────────────────────
 * `npm run db:reset` writes the testing matrix as its fifth step of seven. The operator accounts and
 * the manual bukti-transfer lane are OPT-IN and not part of it. Measured against a reset-only
 * database, `ui-states.mjs` produced 45 misses across 31 surfaces, every one of them a sentence
 * about a surface failing to render — a report that sends its reader to the wrong file entirely.
 * The refusal replaces all 45 with one paragraph naming the command nobody ran.
 *
 * The harmful move is therefore not "a case fails". It is "the run proceeds", which is why this
 * probe measures the PROCESS — its exit status and what it printed — rather than any case.
 *
 * ── THE REACHABILITY CLASSIFICATION ──────────────────────────────────────────────────────────────
 * The old check fetched `/api/health` under a fixed budget and called the expiry "Nothing is
 * serving". A dev server on its first request to a cold route answers in tens of seconds, so a
 * healthy app was reported as a dead one, and the harness's own note — "the harness cannot tell that
 * from a dead server" — was exactly right.
 *
 * Raising the budget is not a repair: it moves the same conflation further out. This probe therefore
 * asserts the property that makes the two states distinguishable at ANY budget — a port nobody
 * answers and a port that answers slowly must classify DIFFERENTLY. Removing the socket check
 * collapses them, and the probe goes red on the collapse rather than on a timeout.
 *
 * CLASS B for both (Rule 36). There is no transaction and no request-path guard to move: each is a
 * guard that runs before the measurement it protects, and the harm is visible only in the POST-STATE
 * afterwards — what the process printed and how it classified.
 *
 * RULE 35. The seed-lane probes create and destroy a real throwaway database. Teardown is in a
 * `finally` around EACH measurement rather than around the suite, because `runProbes` calls
 * `process.exit` and a teardown out there would be skipped by exactly the failure it exists for.
 * `dropProbeDatabase` asserts the name is one of this harness's own throwaways before it drops it.
 *
 * Usage: npm run verify:precondition-probe
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { runProbes, substituteOnce } from "../guard-probe.mjs";
import {
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  migrateProbeDatabase,
  withDatabase,
} from "./throwaway-database.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

const PRECONDITIONS = "scripts/testing/lib-preconditions.mjs";
const MODULE_URL = new URL("../lib-preconditions.mjs", import.meta.url).href;

/**
 * Budges small enough to keep the probe quick, and this is deliberate rather than a compromise.
 *
 * The property under test is that a silent port and a closed port classify DIFFERENTLY, and that is
 * independent of how long the budget is: ECONNREFUSED arrives in microseconds whatever the budget,
 * and a silent port consumes whatever it is given. A probe that spent ninety seconds proving a fact
 * about classification would be measuring the clock.
 */
const PROBE_BUDGETS = { socketBudgetMs: 800, warmBudgetMs: 400, measureBudgetMs: 400 };

/** Runs a snippet as a child process, because the module under mutation must be loaded fresh. */
const runChild = (code, env = {}) => {
  const result = spawnSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

/**
 * Classifies a closed port and an accepting-but-silent port, in one process, and reports both.
 *
 * One process rather than two so the two verdicts come from one load of the module. A dead port is
 * obtained by binding one, reading its number and releasing it — chosen over a hard-coded number so
 * the probe cannot be quietly satisfied by whatever else happens to be running on this machine.
 */
const REACHABILITY_CHILD = `
import { createServer } from "node:net";
import { classifyAppReachability } from ${JSON.stringify(MODULE_URL)};

const reservation = createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const closedPort = reservation.address().port;
await new Promise((r) => reservation.close(r));

const closed = await classifyAppReachability("http://127.0.0.1:" + closedPort, ${JSON.stringify(PROBE_BUDGETS)});

const silent = createServer(() => {});
await new Promise((r) => silent.listen(0, "127.0.0.1", r));

const quiet = await classifyAppReachability("http://127.0.0.1:" + silent.address().port, ${JSON.stringify(PROBE_BUDGETS)});

console.log("VERDICTS " + JSON.stringify({ closed: closed.state, silent: quiet.state }));

// Exiting rather than closing: the classification deliberately leaves sockets to a server that
// never answers, and waiting for them to drain hangs a child whose whole output is already printed.
process.exit(0);
`;

const VERDICTS = /VERDICTS (\{.*\})/;

const classifyBothPorts = () => {
  const run = runChild(REACHABILITY_CHILD);
  const match = VERDICTS.exec(run.output);

  if (!match) {
    throw new Error(
      "the classification child never reported a verdict, so nothing was measured. Its output:\n" +
        run.output.slice(-800),
    );
  }

  return JSON.parse(match[1]);
};

/**
 * Runs `assertSeedLanesPresent()` against a database holding none of the opt-in lanes.
 *
 * The child is the real module and the database is a real one — created, migrated with the
 * repository's own guarded migrator, handed to the check, and dropped in a `finally`. `PROCEEDED` is
 * printed after the call returns, which is the only thing that can distinguish a guard that let the
 * harness through from a child that died before reaching it.
 */
const SEED_LANES_CHILD = `
import { assertSeedLanesPresent } from ${JSON.stringify(MODULE_URL)};
await assertSeedLanesPresent();
console.log("PROCEEDED");
`;

const PROCEEDED = "PROCEEDED";

/** The commands the refusal must name, one per lane that is missing. */
const NAMED_COMMANDS = [
  "npm run db:seed:operators",
  "npm run db:seed:payments",
  "npm run db:reset",
];

/**
 * A migrated throwaway with no lane rows, handed to `work`, and dropped whatever `work` does.
 *
 * Migrated rather than hand-built: the check queries `users` and `finance_payments`, and a fixture
 * schema written to satisfy today's query is a fixture that silently stops being the real thing the
 * day the query changes (Rule 33).
 *
 * The matrix is deliberately NOT seeded here. It writes no operator-role user and no finance row —
 * that is the locked property that makes the two lanes opt-in — so a migrated database with nothing
 * in it is the same input to this check as a reset-only one. The reset-only case itself was measured
 * against the real database and refuses identically; see the verification record.
 */
const withUnseededLaneDatabase = async (work) => {
  const name = PROBE_DATABASES.preconditionUnseeded;
  const url = withDatabase(baseDatabaseUrl(), name);

  await createProbeDatabase(name);

  try {
    migrateProbeDatabase(url);
    return await work(url);
  } finally {
    await dropProbeDatabase(name);
  }
};

/**
 * MEASUREMENT 1 — the committed check, unmutated.
 *
 * Run before the probe suite rather than inside it, because the harness mutates before every
 * detector runs and there is no state in which it hands a detector the file as it stands. This is
 * the run the phase asks for: the repaired precondition, refusing, and naming the command.
 */
const proveTheCommittedCheckRefuses = async () => {
  const run = await withUnseededLaneDatabase((url) =>
    runChild(SEED_LANES_CHILD, { DATABASE_URL: url }),
  );

  if (run.status === 0 || run.output.includes(PROCEEDED)) {
    throw new Error(
      "the committed check let the harness proceed against a database holding none of the opt-in " +
        `lanes, so the repair is not on disk. Its output:\n${run.output.slice(-800)}`,
    );
  }

  const unnamed = NAMED_COMMANDS.filter((command) => !run.output.includes(command));

  if (unnamed.length > 0) {
    throw new Error(
      `the check refused but did not name ${unnamed.join(", ")}, so a reader is told the harness ` +
        `cannot run without being told what to run. Its output:\n${run.output.slice(-800)}`,
    );
  }

  console.log(
    `control  the committed check on a database with no opt-in lanes: REFUSED, naming all ${NAMED_COMMANDS.length} commands\n` +
      "         — an unseeded database is one paragraph, not 45 sentences about surfaces\n",
  );
};

/**
 * MEASUREMENT 2 — the committed classifier, unmutated.
 *
 * The two ports must land in different states. Which two states is not asserted: what is asserted is
 * that they DIFFER, because a classifier that called both `slow` would send its reader looking at a
 * server that is not running, and one that called both `absent` would send them looking for a
 * process that is already up.
 */
const proveTheCommittedClassifierDistinguishes = () => {
  const verdicts = classifyBothPorts();

  if (verdicts.closed === verdicts.silent) {
    throw new Error(
      `the committed classifier called a closed port and a silent one both "${verdicts.closed}", ` +
        "so the repair is not on disk",
    );
  }

  console.log(
    `control  the committed classifier: a closed port is "${verdicts.closed}", a listening port ` +
      `that does not answer is "${verdicts.silent}"\n` +
      "         — the two states a fixed budget could not separate\n",
  );
};

const SOCKET_CHECK_REMOVED =
  "  // probe: the socket is never consulted, so a closed port and a silent one are judged alike\n";

const LANE_CHECK_REMOVED =
  "  // probe: the opt-in lane check never refuses, so an unseeded database is not reported\n" +
  "  return;\n\n";

export const probes = [
  {
    name: "the reachability check reports a live-but-slow app as absent — SOCKET CHECK REMOVED",
    klass: "B",
    harmfulMove:
      "judging reachability by how fast /api/health answers, so a port that accepted the connection " +
      "and is still compiling is reported to the reader as nothing serving on it",
    files: [PRECONDITIONS],
    appliedMarkers: ["// probe: the socket is never consulted"],
    mutate: () => {
      substituteOnce(
        PRECONDITIONS,
        "  const absence = await nothingIsListening(baseUrl, socketBudgetMs);\n" +
          '  if (absence.absent) return { state: "absent", detail: absence.reason };\n',
        SOCKET_CHECK_REMOVED,
      );
    },
    detect: async () => {
      const verdicts = classifyBothPorts();
      const collapsed = verdicts.closed === verdicts.silent;

      return {
        refused: collapsed,
        evidence:
          `closed port "${verdicts.closed}", silent port "${verdicts.silent}" — ` +
          (collapsed
            ? "the two are indistinguishable, so a healthy app under load is reported as a dead one"
            : "they still differ, so the socket check is not what was doing the distinguishing"),
      };
    },
  },
  {
    name: "the harness describes lanes the database does not hold — LANE CHECK REMOVED",
    klass: "B",
    harmfulMove:
      "letting the run proceed against a database without the opt-in seeds, so every money-lane case " +
      "reports a fixture that is not there as a surface that fails to render",
    files: [PRECONDITIONS],
    appliedMarkers: ["// probe: the opt-in lane check never refuses"],
    mutate: () => {
      // The early return is the PROCEED path, so removing it is not the harmful move — it is what
      // turned an earlier version of this probe green, by making the check refuse unconditionally
      // and proving the opposite of what it claimed. What has to go is the refusal, which is
      // reached by returning before it whatever the counts say.
      //
      // The anchor is the single line the early return occupies, and deliberately no longer: an
      // anchor spanning the line below stops matching the moment the formatter reflows that line,
      // and a probe that cannot find its anchor has measured nothing.
      substituteOnce(PRECONDITIONS, "  if (absent.length === 0) return;\n", LANE_CHECK_REMOVED);
    },
    detect: async () => {
      const run = await withUnseededLaneDatabase((url) =>
        runChild(SEED_LANES_CHILD, { DATABASE_URL: url }),
      );

      const proceeded = run.status === 0 && run.output.includes(PROCEEDED);
      const refusedByName = NAMED_COMMANDS.some((command) => run.output.includes(command));

      if (!proceeded && !refusedByName) {
        throw new Error(
          "the child neither proceeded nor named a seed command, so it died somewhere other than " +
            `the check and this run measured nothing. Its output:\n${run.output.slice(-800)}`,
        );
      }

      return {
        refused: proceeded,
        evidence:
          (proceeded
            ? "the harness proceeded against an unseeded database, with nothing between it and 45 " +
              "per-case misses"
            : "it still refused, so the lane check is not what was holding the harness back") +
          ` (exit ${run.status})`,
      };
    },
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await proveTheCommittedCheckRefuses();
  proveTheCommittedClassifierDistinguishes();
  await runProbes(probes);
}
