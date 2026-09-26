/*
 * Rule 36 probes for the register gate.
 *
 * WHY THIS FILE EXISTS. `npm run verify:register` asserts twelve obligations — eleven held at a
 * number, nine of them exactly and two as floors, and one reported rather than asserted — over
 * `open-debt.md`, `decision-log.md` and the close procedure that runs it. A pinned literal is a
 * claim about what the file currently contains, and the Phase 2 precedent
 * is explicit: the census
 * ratchet pinned at 40 was never observed failing, and a ratchet that has never gone red is a
 * literal nobody has tested — it could be asserting a number that no input can move. So each probe
 * here breaks the file the way the defect was actually found in it, and requires the gate to go red
 * naming THAT obligation and THAT measured number.
 *
 * THE CONTROL MATTERS AS MUCH AS THE PROBES. A gate that was already red before anything was
 * mutated would make every probe below report "red as claimed" while proving nothing about the
 * mutation. The entry point therefore requires the gate GREEN before the first probe runs, and
 * refuses the whole suite if it is not.
 *
 * CLASS D (Rule 36): the gate is a read-only instrument over three text files — there is no write to
 * reorder and no transaction to roll back, so the detector is result content. Every probe's failure
 * mode is the same: the harm is an unrecorded item, a broken row or a vacuous instrument, not a
 * committed mutation, so "what did it refuse and why" is the whole of the evidence.
 *
 * WHERE THESE FILES LIVE. `docs/` is a git repository in its own right (Rule 26), nested inside a
 * product repository that ignores it (DEC-0101). The harness's `assertTracked`, `pathsClean` and
 * `restoreFromGit` therefore run with `repo: DOC_LANE` — without it they would ask the product
 * repository about files it has never tracked, read "clean" for an ignored path, and fail the
 * checkout from the `finally`, which is the one place a throw leaves the mutation on disk.
 *
 * Usage: npm run verify:register-probe
 * Runs only over committed work; the harness refuses if any register differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";
import { liveAnchorItem } from "./live-anchor-item.mjs";

const REGISTER = "docs/project/open-debt.md";
const DECISION_LOG = "docs/project/decision-log.md";

/**
 * The close procedure, listed by the path git knows it by in the doc repository.
 *
 * `.claude/` at the repository root is a symlink into `docs/` (Rule 26), so this is one file with
 * two spellings. The list has to use the one `repoRelative("docs", …)` can translate, or the
 * harness refuses the probe rather than restoring it.
 */
const CLOSE_STEP = "docs/.claude/commands/close-step.md";

/** The doc lane's own repository, which is where every git call about these files belongs. */
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
 *
 * THE ID IS OUT OF THE REGISTER'S RANGE ON PURPOSE, and it was not always. The check this probe
 * exercises reads the live ID SET against the doc lane's committed baseline, so planting an id the
 * register already holds adds no id and the gate answers `(0 filed)` — the probe then reports NOT
 * PROVEN while the guard is working perfectly. A probe that names "the next free id" has a fixture
 * that expires the moment someone files it, and this one did.
 */
const PLANTED_ITEM = "- **LAUNCH-D9999 [HIGH]** filed by the register-gate probe with no anchor.\n";

const D47_ANCHORED = "- **LAUNCH-D47 [HIGH] → Step 7.7 Block C2.";
const D40_ANCHORED = "- **LAUNCH-D40 [MEDIUM] → Step 7.7 Block D.**";
const BETA_D29_MARKED = "- **BETA-D29 [LOW]** → Step 7.7 · DISCHARGED 2026-09-09.";

/**
 * A bullet whose head token the head matcher reads and the id test then rejects.
 *
 * `LAUNCH-D99X` is the shape of the defect the skip count exists for: a trailing character past the
 * digits, which is what a mistyped id looks like. The head matcher takes it as an id — and it is
 * then dropped by the id test, so it appears in no population and in no grep for any id.
 */
const PLANTED_MISTYPED_ID = "- **LAUNCH-D99X [HIGH]** filed by the register-gate probe.\n";

/**
 * The same defect, planted inside a `Learnings` subsection instead of a live one.
 *
 * The census excludes `Learnings` bullets from the skip count because they are prose lessons that
 * never carried ids, and that exclusion is a HOLE: a genuinely mistyped id written there is not
 * counted. This fixture is that hole, made visible rather than argued about.
 *
 * A SECOND ID RATHER THAN A SECOND COPY OF THE FIRST, so the two plants are distinguishable on disk
 * and `appliedMarkers` can require both. Two copies of one id would satisfy the marker check with
 * either plant alone.
 */
const PLANTED_MISTYPED_ID_IN_LEARNINGS =
  "- **LAUNCH-D98X [HIGH]** filed by the register-gate probe inside a Learnings subsection.\n";

/** A `Learnings` heading, which is what the exclusion keys on — the section KIND, not this text. */
const BLOCK_B_LEARNINGS_HEADING = "### Learnings (Step 7.7 Block B, 2026-09-09)\n";

/**
 * The close procedure's two steps as the file writes them, commands and all.
 *
 * The gate matches on these strings rather than on prose about them, so a probe that moves one has
 * to move the real line. The block is removed whole — fence and all — and the command is put back
 * below the commit, which is the wrong order and runnable.
 */
const CLOSE_STEP_GATE_BLOCK = "   ```\n   npm run verify:register\n   ```\n\n";
const CLOSE_STEP_COMMIT_LINE =
  '   cd docs && git add -A && git commit -m "<work unit>" && git push\n';

/**
 * The Supersedes cell of DEC-0010, which holds nothing but an id — the whole of the claim reading.
 *
 * The three supersede obligations examine this one cell of the column's 204, so this is the cell
 * whose loss would leave them asserting over an empty population and still reporting green. The
 * replacement is prose that names the same id, so the row's meaning is unchanged and only the
 * reading loses it — which is exactly the shrinkage the floor is there to catch.
 */
const SUPERSEDES_CELL_OF_DEC_0010 = "| DEC-0153        |";

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
/**
 * A live item's head line inside a `##` block's BODY, which is the population arm (b) created.
 *
 * LAUNCH-D69 sits in the body of `## Known Debt (Step 7.7 Block C Phase 2, 2026-09-13)` — no `###`
 * heading between it and the block — so before arm (b) existed this item was in no live population
 * at all. The anchor runs to the end of the line rather than to the end of the sentence, because a
 * prefix is what `substituteOnce` needs and this one is unique in the file.
 */
const D69_BLOCK_BODY_HEAD =
  "- **LAUNCH-D69 [LOW] → Step 7.7 Block C Phase 3. The routing census classifies, but only two";

/** The same defect, planted into that body. Id out of the register's range, as above. */
const PLANTED_BLOCK_BODY_ITEM =
  "- **LAUNCH-D9998 [HIGH] → Block C2.** filed by the register-gate probe in a debt block's body.\n";

/**
 * What a withdrawal looks like on an anchor line: the mark, then the closing `**`.
 *
 * `· WITHDRAWN` is the register's own mark for an item it has taken out without discharging it and
 * is not a kind of `· DISCHARGED` — which is the whole reason this probe exists alongside the
 * discharge obligation three probes up.
 */
const WITHDRAWAL_SUFFIX = " · WITHDRAWN 2026-09-25, probe.**";

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
    appliedMarkers: ["LAUNCH-D9999"],
    mutate: () => substituteOnce(REGISTER, D47_ANCHORED, PLANTED_ITEM + D47_ANCHORED),
    detect: () =>
      gateRefused(/FAIL\s+a live item filed since docs@[0-9a-f]+ names a step \(\d+ filed\)/),
  },
  {
    name: "an item naming a block without naming a step fails the close",
    klass: "D",
    harmfulMove:
      "writing `→ Block C2` where the destination rule says `→ Step 7.7 Block C2`, so the anchor names a block no grep for the step can find",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **LAUNCH-D47 [HIGH] → Block C2."],
    mutate: () => substituteOnce(REGISTER, D47_ANCHORED, "- **LAUNCH-D47 [HIGH] → Block C2."),
    detect: () => gateRefused(/FAIL\s+no live item names a block without naming a step \(\d+\)/),
  },
  {
    name: "a discharge declared in prose but not on the anchor line fails the close",
    klass: "D",
    harmfulMove:
      "leaving · DISCHARGED off the anchor line of an item a discharge section already declares discharged, so the file reports the same id as both discharged and live",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **BETA-D29 [LOW]** → Step 7.7."],
    mutate: () => substituteOnce(REGISTER, BETA_D29_MARKED, "- **BETA-D29 [LOW]** → Step 7.7."),
    detect: () =>
      gateRefused(
        /FAIL\s+\d+\s+items a discharged section declares discharged whose anchor line carries no mark\s+\(up 1\)/,
      ),
  },
  {
    // ARM (b) OF THE LIVE PREDICATE, which is the half of LAUNCH-D138 nothing else can reach. The
    // plant is a live item by every field the census reads — a severity bracket and an anchor of its
    // own — and wrong only in where it sits: the body of a `##` block, with no `###` heading over it.
    // Before arm (b) this item was in no live population, so gate (b) read `(0)` on it and the probe
    // could not go red; the detector is therefore gate (b)'s own number, not the item's existence.
    name: "an item filed in a debt block's body is live",
    klass: "D",
    harmfulMove:
      "filing an item in the body of a `## Known Debt` block rather than under a `###` heading, where the census of the day counted nothing — not the item, not its anchor, and not the missing destination of either",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["LAUNCH-D9998"],
    mutate: () =>
      substituteOnce(REGISTER, D69_BLOCK_BODY_HEAD, PLANTED_BLOCK_BODY_ITEM + D69_BLOCK_BODY_HEAD),
    detect: () => gateRefused(/FAIL\s+no live item names a block without naming a step \(\d+\)/),
  },
  {
    // THE WITHDRAWAL MARK, which is not a discharge and has to hold on both arms. The subject is
    // whichever live item the register is holding when the probe runs — `liveAnchorItem` derives it
    // and refuses by name when none qualifies — so marking it withdrawn takes it out of the live
    // set and the anchored floor, the one asserted population that shrinks, is what says so. A
    // `· DISCHARGED` plant here would go red for the obligation three probes up instead, which is
    // why this one plants the other mark.
    name: "an item withdrawn on its anchor line leaves the live set",
    klass: "D",
    harmfulMove:
      "marking an anchor line `· WITHDRAWN` while the census reads only `· DISCHARGED`, so an item the register has withdrawn keeps counting as open work and keeps its place in every ratchet",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["· WITHDRAWN 2026-09-25, probe."],
    mutate: () => {
      // Resolved inside the mutation rather than at import: `probe-coverage.test.ts` imports this
      // suite as data, and a refusal over the register's current contents is this suite's to
      // report, not that test's to fail.
      const { anchored } = liveAnchorItem(REGISTER);
      substituteOnce(REGISTER, anchored, anchored + WITHDRAWAL_SUFFIX);
    },
    detect: () =>
      gateRefused(
        /FAIL\s+\d+\s+live debt ids carrying an anchor that names a step and a block\s+\(down 1 — below the floor of \d+\)/,
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
      gateRefused(/FAIL\s+\d+\s+distinct live debt ids carrying no anchor at all\s+\(up 1\)/),
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
      gateRefused(
        /FAIL\s+\d+\s+decision-log rows whose cells do not match their columns' declared count\s+\(up 1\)/,
      ),
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
      gateRefused(
        /FAIL\s+\d+\s+decision-log rows a blank line left outside every table\s+\(up 1\)/,
      ),
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
      gateRefused(
        /FAIL\s+\d+\s+decision-log rows written on another record's line instead of below it\s+\(up 1\)/,
      ),
  },
  {
    name: "a Date cell that does not hold a date fails the close",
    klass: "D",
    harmfulMove:
      "putting a status token where the date belongs, so the row cannot be ordered in time",
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
      gateRefused(/FAIL\s+\d+\s+decision-log rows whose Date cell does not hold a date\s+\(up 1\)/),
  },
  {
    name: "a supersede claim naming its own row fails the close",
    klass: "D",
    harmfulMove:
      "writing a row's own id into its Supersedes cell, which states a relation the row cannot stand in",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["1759 tests passing. | DEC-0124 |"],
    mutate: () => substituteOnce(DECISION_LOG, SUPERSEDES_CELL_OF_DEC_0124, "DEC-0124 |"),
    detect: () =>
      gateRefused(/FAIL\s+\d+\s+decision-log supersede claims naming their own row\s+\(up 1\)/),
  },
  {
    name: "a supersede claim naming an id with no row fails the close",
    klass: "D",
    harmfulMove:
      "naming an id the log has no record for, so the claim can never be checked against the row it names",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["1759 tests passing. | DEC-0900 |"],
    mutate: () => substituteOnce(DECISION_LOG, SUPERSEDES_CELL_OF_DEC_0124, "DEC-0900 |"),
    detect: () =>
      gateRefused(
        /FAIL\s+\d+\s+decision-log supersede claims naming an id the log has no row for\s+\(up 1\)/,
      ),
  },
  {
    name: "an anchor rewritten to point nowhere fails the anchored floor",
    klass: "D",
    harmfulMove:
      "rewriting an existing canonical anchor to `→ TBD`, which leaves the item anchored enough to satisfy every other instrument while its destination is gone — a degradation rather than a disappearance, and the one population no other check reads",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["- **LAUNCH-D40 [MEDIUM] → TBD.**"],
    mutate: () => substituteOnce(REGISTER, D40_ANCHORED, "- **LAUNCH-D40 [MEDIUM] → TBD.**"),
    // The two numbers are `\d+`. The floor moves whenever an anchored item is filed, and the
    // measured count moves with it, so a pinned literal stops matching the gate's output — and a
    // detector that matches nothing makes the harness THROW rather than report, which aborts the
    // suite here and leaves every probe below it unrun. What this probe claims is the SHAPE: a
    // rewritten anchor falls the population by exactly one and the gate names it. The floor's
    // current value is not part of that claim.
    detect: () =>
      gateRefused(
        /FAIL\s+\d+\s+live debt ids carrying an anchor that names a step and a block\s+\(down 1 — below the floor of \d+\)/,
      ),
  },
  {
    name: "a bullet filed with a mistyped id fails the skip count",
    klass: "D",
    harmfulMove:
      "filing a bullet whose head token looks like a register id and is not one, so the census drops it silently and it appears in no population and in no grep for the id the author meant",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["LAUNCH-D99X"],
    mutate: () => substituteOnce(REGISTER, D47_ANCHORED, PLANTED_MISTYPED_ID + D47_ANCHORED),
    detect: () =>
      gateRefused(/FAIL\s+\d+\s+register bullets whose head id is not a register id\s+\(up 1\)/),
  },
  {
    // THE NUMBER IS THE WHOLE ASSERTION, and it is why this is one probe and not two. Two mistyped
    // ids are planted in the same run — one in a live section, one inside a `Learnings` subsection —
    // and the count is required to move by exactly ONE. If the exclusion were removed the gate would
    // read `(up 2)`, this regex would miss, and the probe would report NOT PROVEN rather than
    // quietly passing. A probe that planted only inside `Learnings` could not be red at all: the
    // gate would stay green, which this harness reads as an unproven guard and not as evidence.
    name: "the Learnings exclusion is exactly one bullet wide",
    klass: "D",
    harmfulMove:
      "excluding Learnings bullets from the skip count so broadly that a mistyped id in an ordinary live section stops being counted too, which would turn a measured fail-open back into a silent one",
    files: [REGISTER],
    repo: DOC_LANE,
    appliedMarkers: ["LAUNCH-D99X", "LAUNCH-D98X"],
    mutate: () => {
      substituteOnce(REGISTER, D47_ANCHORED, PLANTED_MISTYPED_ID + D47_ANCHORED);
      substituteOnce(
        REGISTER,
        BLOCK_B_LEARNINGS_HEADING,
        BLOCK_B_LEARNINGS_HEADING + "\n" + PLANTED_MISTYPED_ID_IN_LEARNINGS,
      );
    },
    detect: () =>
      gateRefused(/FAIL\s+\d+\s+register bullets whose head id is not a register id\s+\(up 1\)/),
  },
  {
    name: "the supersede reading cannot shrink to nothing",
    klass: "D",
    harmfulMove:
      "turning the one Supersedes cell that holds nothing but an id into prose, which takes the three supersede obligations from asserting over one cell to asserting over none while they keep reporting green",
    files: [DECISION_LOG],
    repo: DOC_LANE,
    appliedMarkers: ["| Extends DEC-0153 |"],
    mutate: () => substituteOnce(DECISION_LOG, SUPERSEDES_CELL_OF_DEC_0010, "| Extends DEC-0153 |"),
    detect: () =>
      gateRefused(
        /FAIL\s+\d+\s+decision-log Supersedes cells holding nothing but an id\s+\(down 1 — below the floor of \d+\)/,
      ),
  },
  {
    // The running-order assertion is the ONLY instrument that catches this, and that is the finding
    // rather than a coincidence: gate (a) compares the register against the doc lane's HEAD, and a
    // gate that has already been run after the commit is comparing that commit to itself. Nothing
    // else in the suite reads the close procedure at all, so without this assertion the wrong order
    // would be caught by nothing — the probe says so because degrading rather than vanishing is the
    // property worth pinning.
    name: "moving the gate below the doc-lane commit fails the running order",
    klass: "D",
    harmfulMove:
      "running the commit before the gate, which leaves the gate's baseline holding the very filing it exists to judge — it then finds nothing new and passes on an empty population, reporting a green close over the defect it was run to catch",
    files: [CLOSE_STEP],
    repo: DOC_LANE,
    appliedMarkers: [
      'cd docs && git add -A && git commit -m "<work unit>" && git push\n   npm run verify:register',
    ],
    mutate: () => {
      substituteOnce(CLOSE_STEP, CLOSE_STEP_GATE_BLOCK, "");
      substituteOnce(
        CLOSE_STEP,
        CLOSE_STEP_COMMIT_LINE,
        CLOSE_STEP_COMMIT_LINE + "   npm run verify:register\n",
      );
    },
    detect: () =>
      gateRefused(
        /FAIL\s+\.claude\/commands\/close-step\.md runs the gate at :\d+ before the doc-lane commit at :\d+/,
      ),
  },
];

// Exported as DATA and run only when this file IS the entry point, so the coverage test can read
// the probe set without mutating the tree to find out.
//
// `verify:register` reads three text files and nothing else — the shared precondition's soundness
// argument holds for it, and `scripts/testing/guard-probe.mjs` carries it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  requireGreenBeforeProbing("register-gate", [["npm", VERIFY]]);
  await runProbes(probes);
}
