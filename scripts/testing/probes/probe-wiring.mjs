/*
 * Rule 36 probes for the wiring check itself — `scripts/testing/probe-coverage.test.ts`'s
 * "every probe suite is wired" block.
 *
 * That block asserts two things at once and neither of them is visible from a green run: that every
 * suite in `scripts/testing/probes/` is run by EXACTLY ONE workflow, and that the declared library
 * list cannot be used to remove a suite from the population it covers. Both are properties of files
 * that nothing executes, so a mistake in either direction produces a suite that never runs and a
 * report that says nothing — which is the shape LAUNCH-D173 is made of, and the reason this file
 * exists rather than a note in the test.
 *
 * CLASS C — the mutation is to a workflow or to a declaration, and the detector is the test's own
 * verdict naming the suite it lost.
 *
 * THREE PROBES, ONE PER WAY THE CHECK CAN BE DEFEATED:
 *
 *   (a) A suite's step is DELETED from `nightly-probes.yml`. The suite now runs nowhere. Nothing
 *       else in the repository changes, every other check stays green, and the suite's guard is
 *       unproven from that merge onwards.
 *   (b) A suite already run by `ci.yml` is DUPLICATED into `nightly-probes.yml`. Both copies pass
 *       today; the harm is that they are two definitions, and the next person to change one leaves
 *       the other asserting the old premise (DEBT-VERIFY-YML-UNPINNED is that state, arrived at).
 *   (c) A suite's basename is added to `PROBE_LIBRARIES`. It leaves the population the check covers
 *       while the file still sits in the directory and still looks wired; the only assertion that
 *       can see this is the one requiring every declared library to be imported by a suite.
 *
 * Usage: node scripts/testing/probes/probe-wiring.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const NIGHTLY = ".github/workflows/nightly-probes.yml";
const COVERAGE_TEST = "scripts/testing/probe-coverage.test.ts";

const READY_GATE = "        if: ${{ !cancelled() && steps.database-ready.outcome == 'success' }}";

const stepFor = (suite) => [
  `      - name: "Probe suite: ${suite}"`,
  READY_GATE,
  `        run: node scripts/testing/probes/${suite}.mjs`,
];

/** The suite (a) deletes, and the step block it occupies. */
const DELETED_SUITE = "seed-guard";
const DELETED_STEP = [...stepFor(DELETED_SUITE), ""].join("\n");

/** The suite (b) duplicates, and where the copy lands. */
const DUPLICATED_SUITE = "reindex-guard";
const DUPLICATION_ANCHOR = `      - name: "Probe suite: backfill-rejected-batch"\n`;

/** The suite (c) hides by declaring it a library. */
const HIDDEN_SUITE = "upload-rate-limit";

/**
 * Each detector names the SUITE it lost, on the one line vitest prints the assertion message on.
 * A regex that only matched "expected [...] to have a length of 1" would go red for a probe that
 * broke some other assertion entirely, and would not have observed the wiring at all.
 */
const REACHED_UNWIRED = /seed-guard is run by 0 workflows: none/;
const REACHED_DOUBLE_WIRED = /reindex-guard is run by 2 workflows/;
const REACHED_HIDDEN =
  /upload-rate-limit is declared a probe library but no probe suite imports it/;

const wiringTest = (reached) => fails("npx", ["vitest", "run", COVERAGE_TEST], reached);

export const probes = [
  {
    name: "a suite deleted from nightly-probes.yml fails the run, naming it",
    // CLASS C. Deleting a step of a workflow nothing runs on demand breaks nothing that runs: the
    // job stays green, one line shorter, and the suite it used to prove joins the set that runs
    // nowhere. That set is what LAUNCH-D173 was.
    klass: "C",
    harmfulMove: `deleting ${DELETED_SUITE}'s step, so the suite runs nowhere and its guard is unproven`,
    files: [NIGHTLY],
    appliedMarkers: ["      # probe: this suite's step removed"],
    mutate: () =>
      substituteOnce(NIGHTLY, DELETED_STEP, "      # probe: this suite's step removed\n"),
    detect: async () => wiringTest(REACHED_UNWIRED),
  },
  {
    name: "a suite run in two workflows fails the run, naming it",
    // CLASS C. The duplicate passes today, which is the whole problem: the check exists because two
    // definitions of one suite drift, and the drift is invisible until one of them stops matching
    // the thing it guards. `reindex-guard` is one of the six already run by ci.yml.
    klass: "C",
    harmfulMove: `running ${DUPLICATED_SUITE} from two workflows, so one copy can be changed and the other left behind`,
    files: [NIGHTLY],
    appliedMarkers: [`      - name: "Probe suite: ${DUPLICATED_SUITE}"`],
    mutate: () =>
      substituteOnce(
        NIGHTLY,
        DUPLICATION_ANCHOR,
        [...stepFor(DUPLICATED_SUITE), "", DUPLICATION_ANCHOR.trimEnd() + "\n"].join("\n"),
      ),
    detect: async () => wiringTest(REACHED_DOUBLE_WIRED),
  },
  {
    name: "declaring a suite a library fails the run, naming it",
    // CLASS C. The library list exists because four modules in that directory are shared helpers
    // rather than suites, and it is data — so it is also the one edit that silently removes a suite
    // from the population. The suite's file stays, its step in the workflow stays, and the check
    // that counts workflows never sees it again. Only the importers assertion closes this.
    klass: "C",
    harmfulMove: `listing ${HIDDEN_SUITE} as a library, so it leaves the population the wiring check covers`,
    files: [COVERAGE_TEST],
    appliedMarkers: [`  "${HIDDEN_SUITE}",`],
    mutate: () =>
      substituteOnce(COVERAGE_TEST, '  "detectors",\n', `  "detectors",\n  "${HIDDEN_SUITE}",\n`),
    detect: async () => wiringTest(REACHED_HIDDEN),
  },
];

// Exported as DATA and run only when this file IS the entry point, so the probe-coverage test can
// read the probe set without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // The check reads the tree and nothing else — no database, no clock, no browser — so measuring it
  // once for the whole suite is sound: the harness restores every mutated file from git after each
  // probe and throws if the restore did not land.
  requireGreenBeforeProbing("probe-wiring", [["npx", ["vitest", "run", COVERAGE_TEST]]]);
  await runProbes(probes);
}
