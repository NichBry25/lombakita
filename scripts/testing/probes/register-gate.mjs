/*
 * Rule 36 probes for the register gate.
 *
 * WHY THIS FILE EXISTS. `npm run verify:register` asserts eight pinned literals over
 * `open-debt.md` and `decision-log.md`. A pinned literal is a claim about what the file currently
 * contains, and the Phase 2 precedent is explicit: the census ratchet pinned at 40 was never
 * observed failing, and a ratchet that has never gone red is a literal nobody has tested — it could
 * be asserting a number that no input can move. So each probe here breaks the file the way the
 * defect was actually found in it, and requires the gate to go red naming THAT obligation and THAT
 * measured number.
 *
 * THE CONTROL MATTERS AS MUCH AS THE PROBES. A gate that was already red before anything was
 * mutated would make every probe below report "red as claimed" while proving nothing about the
 * mutation. The entry point therefore requires the gate GREEN before the first probe runs, and
 * refuses the whole suite if it is not.
 *
 * CLASS D (Rule 36): the gate is a read-only instrument over two text files — there is no write to
 * reorder and no transaction to roll back, so the detector is result content. Every probe's failure
 * mode is the same: the harm is an unrecorded item or a broken row, not a committed mutation, so
 * "what did it refuse and why" is the whole of the evidence.
 *
 * WHERE THESE FILES LIVE. `docs/` is a git repository in its own right (Rule 26), nested inside a
 * product repository that ignores it (DEC-0101). The harness's `assertTracked`, `pathsClean` and
 * `restoreFromGit` therefore run with `repo: DOC_LANE` — without it they would ask the product
 * repository about files it has never tracked, read "clean" for an ignored path, and fail the
 * checkout from the `finally`, which is the one place a throw leaves the mutation on disk.
 *
 * Usage: npm run verify:register-probe
 * Runs only over committed work; the harness refuses if either register differs from HEAD.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const REGISTER = "docs/project/open-debt.md";
const DECISION_LOG = "docs/project/decision-log.md";

/** The doc lane's own repository, which is where every git call about these two files belongs. */
const DOC_LANE = "docs";

const VERIFY = ["run", "verify:register"];

/** The gate, requiring it to have gone red naming `reached`. */
const gateRefused = (reached) => fails("npm", VERIFY, reached);

/**
 * A live item one line long, filed with no anchor at all.
 *
 * Inserted ABOVE an existing item rather than appended, so it lands inside a section whose
 * sub-heading already states liveness and the probe measures the anchor rule rather than the
 * census's ability to guess what an item at the end of the file is.
 */
const PLANTED_ITEM = "- **LAUNCH-D99 [HIGH]** filed by the register-gate probe with no anchor.\n";

const D47_ANCHORED = "- **LAUNCH-D47 [HIGH] → Step 7.7 Block C2.";
const D40_ANCHORED = "- **LAUNCH-D40 [MEDIUM] → Step 7.7 Block D.**";
const BETA_D29_MARKED = "- **BETA-D29 [LOW]** → Step 7.7 · DISCHARGED 2026-09-09.";

/**
 * Row prefixes run as far as the `| owner |` cell on purpose.
 *
 * The Index table repeats every decision's id and title, so an anchor that stops at the title
 * matches twice and `substituteOnce` refuses it. `| owner |` is a Seeded Decisions column and
 * appears in no Index row, which is what makes these unambiguous.
 *
 * DEC-0125's row is glued onto DEC-0124's because DEC-0124 declares seven cells. That detail is the
 * whole of the mutation: the log's glue detector keys on a doubled pipe, which puts the glued
 * record's id exactly one stride (columns + 1) past an empty cell. DEC-0112's row declares ten
 * cells — it is itself one of the off-column rows — so gluing onto IT lands the id at the wrong
 * offset and the line is read as one long record instead of two.
 */
const ROW_DEC_0125 =
  "| DEC-0125 | Competition submissions become readable by the organizer, validated against their " +
  "own bytes, and stored under a competition-first key | accepted | 2026-07-30 | owner |";

const ROW_DEC_0114 =
  "| DEC-0114 | Every platform-ops mutation writes an audit row | accepted | 2026-07-26 | owner |";

/**
 * The whole Supersedes cell of DEC-0124, replaced by a bare id.
 *
 * `supersedeClaimOf` reads a claim only from a cell holding nothing but an id, and that restriction
 * is deliberate: its own measurement found that reading every id out of a prose cell reports eight
 * direction defects where one is real. So a planted defect has to have the shape the detector
 * actually reads — prose naming a newer decision is an unpolished cell, not a false claim, and the
 * gate is right not to call it one.
 *
 * Both supersede probes below plant into THIS cell, and the two ids are chosen to land in different
 * obligations from the same anchor: DEC-0124's own id is a claim on the row itself, and DEC-0900 is
 * an id the log has no row for. Planting a NEWER id here — which is what this cell held as a probe
 * before the split — now moves an obligation the gate reports rather than asserts, so it would make
 * the gate print a larger number and exit zero. That probe is gone on purpose: a red run is the only
 * thing this harness accepts as evidence, and there is no longer a guard for it to go red against.
 */
const SUPERSEDES_CELL_OF_DEC_0124 =
  "Extends DEC-0123 (same session) with the post-event half of the lifecycle. Reuses the DEC-0121 " +
  "derived-not-stored principle. Protects DEC-0122's retention trigger, which is measured from " +
  "`event_end_at`. Does not change the publish gate itself (DEC-0108) or `IMMUTABLE_AFTER_PUBLISH` " +
  "(Step 3.3). |";

export const probes = [
  {
    name: "an item filed with no anchor fails the close",
    klass: "D",
    harmfulMove:
      "filing an item with no destination, which is invisible to every anchored grep the next reader runs",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["LAUNCH-D99"],
    mutate: () => substituteOnce(REGISTER, D47_ANCHORED, PLANTED_ITEM + D47_ANCHORED),
    detect: () =>
      gateRefused(/FAIL\s+a live item filed since docs@[0-9a-f]+ names a step \(1 filed\)/),
  },
  {
    name: "an item naming a block without naming a step fails the close",
    klass: "D",
    harmfulMove:
      "writing `→ Block C2` where the destination rule says `→ Step 7.7 Block C2`, so the anchor names a block no grep for the step can find",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **LAUNCH-D47 [HIGH] → Block C2."],
    mutate: () =>
      substituteOnce(REGISTER, D47_ANCHORED, "- **LAUNCH-D47 [HIGH] → Block C2."),
    detect: () => gateRefused(/FAIL\s+no live item names a block without naming a step \(1\)/),
  },
  {
    name: "a discharge declared in prose but not on the anchor line fails the close",
    klass: "D",
    harmfulMove:
      "leaving · DISCHARGED off the anchor line of an item a discharge section already declares discharged, so the file reports the same id as both discharged and live",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **BETA-D29 [LOW]** → Step 7.7."],
    mutate: () =>
      substituteOnce(REGISTER, BETA_D29_MARKED, "- **BETA-D29 [LOW]** → Step 7.7."),
    detect: () =>
      gateRefused(
        /FAIL\s+3\s+items a discharged section declares discharged whose anchor line carries no mark/,
      ),
  },
  {
    name: "the anchorless ratchet can go red",
    klass: "D",
    harmfulMove:
      "stripping the anchor off an already-filed live item, raising the stock of anchorless items without filing anything new",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **LAUNCH-D40 [MEDIUM].**"],
    mutate: () => substituteOnce(REGISTER, D40_ANCHORED, "- **LAUNCH-D40 [MEDIUM].**"),
    detect: () =>
      gateRefused(/FAIL\s+51\s+distinct live debt ids carrying no anchor at all\s+\(up 1\)/),
  },
  {
    name: "a row off its column count fails the close",
    klass: "D",
    harmfulMove:
      "adding a cell to a well-formed row, so the row reads as a different record to every column-indexed reader",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["reversible via uninstall | n/a | probe |"],
    mutate: () =>
      substituteOnce(
        DECISION_LOG,
        "reversible via uninstall | n/a |",
        "reversible via uninstall | n/a | probe |",
      ),
    detect: () =>
      gateRefused(/FAIL\s+1\s+decision-log rows whose cells do not match their columns' declared count\s+\(up 1\)/),
  },
  {
    name: "a blank line ending a table fails the close",
    klass: "D",
    harmfulMove:
      "inserting a blank line inside a table, which drops every row below it out of the table for any reader that walks it",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["\n\n| DEC-0114 | Every platform-ops mutation writes an audit row"],
    mutate: () => substituteOnce(DECISION_LOG, `\n${ROW_DEC_0114}`, `\n\n${ROW_DEC_0114}`),
    detect: () =>
      gateRefused(/FAIL\s+97\s+decision-log rows a blank line left outside every table\s+\(up 1\)/),
  },
  {
    name: "two records glued onto one line fail the close",
    klass: "D",
    harmfulMove:
      "deleting the newline between two records, so the second is read as the first record's trailing cells",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["|| DEC-0125 |"],
    mutate: () => substituteOnce(DECISION_LOG, `\n${ROW_DEC_0125}`, ROW_DEC_0125),
    detect: () =>
      gateRefused(/FAIL\s+2\s+decision-log rows written on another record's line instead of below it/),
  },
  {
    name: "a Date cell that does not hold a date fails the close",
    klass: "D",
    harmfulMove: "putting a status token where the date belongs, so the row cannot be ordered in time",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["between 6.5h and 6.5.INFRA | accepted | accepted |"],
    mutate: () =>
      substituteOnce(
        DECISION_LOG,
        "between 6.5h and 6.5.INFRA | accepted | 2026-07-07 |",
        "between 6.5h and 6.5.INFRA | accepted | accepted |",
      ),
    detect: () =>
      gateRefused(/FAIL\s+2\s+decision-log rows whose Date cell does not hold a date/),
  },
  {
    name: "a supersede claim naming its own row fails the close",
    klass: "D",
    harmfulMove:
      "writing a row's own id into its Supersedes cell, which states a relation the row cannot stand in",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["1759 tests passing. | DEC-0124 |"],
    mutate: () =>
      substituteOnce(DECISION_LOG, SUPERSEDES_CELL_OF_DEC_0124, "DEC-0124 |"),
    detect: () =>
      gateRefused(/FAIL\s+1\s+decision-log supersede claims naming their own row\s+\(up 1\)/),
  },
  {
    name: "a supersede claim naming an id with no row fails the close",
    klass: "D",
    harmfulMove:
      "naming an id the log has no record for, so the claim can never be checked against the row it names",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["1759 tests passing. | DEC-0900 |"],
    mutate: () =>
      substituteOnce(DECISION_LOG, SUPERSEDES_CELL_OF_DEC_0124, "DEC-0900 |"),
    detect: () =>
      gateRefused(
        /FAIL\s+1\s+decision-log supersede claims naming an id the log has no row for\s+\(up 1\)/,
      ),
  },
];

/**
 * Proves the gate was GREEN before the first probe touched anything.
 *
 * Without this the suite cannot distinguish "the mutation made it red" from "it was already red",
 * and every probe below would report itself proven over a register that fails on its own.
 */
const requireGreenBeforeProbing = () => {
  const result = spawnSync("npm", VERIFY, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status !== 0) {
    throw new Error(
      "the register is already red before anything was mutated, so a probe going red afterwards " +
        `would prove nothing about the mutation:\n${output.slice(-1500)}`,
    );
  }
};

// Exported as DATA and run only when this file IS the entry point, so the coverage test can read
// the probe set without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  requireGreenBeforeProbing();
  await runProbes(probes);
}
