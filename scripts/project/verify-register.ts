/**
 * The register gate: what a close must be able to assert about `open-debt.md` and `decision-log.md`
 * before the work unit is allowed to close.
 *
 * WHY THIS IS A GATE AND NOT A REPORT. Both files are read by grep. An id that is filed without an
 * anchor, a row whose cells do not match its columns, a blank line that ends a table — none of them
 * makes anything fail. They make the greps that every future reader depends on return something
 * other than the truth, silently, and the reader has no way to tell. This script is the only thing
 * that notices, so it exits non-zero.
 *
 * FOUR INSTRUMENTS, FOUR SHAPES, deliberately not one:
 *
 *  - GATE (a), newly filed items only. An item the close under processing files must carry an anchor
 *    naming a step. Its population comes from the doc lane's own last commit, so it needs no pinned
 *    literal and never fails on debt that was already there. This is what stops the bleeding.
 *  - GATE (b), the whole file. No live item may name a block without naming a step.
 *  - OBLIGATIONS, the whole file, each asserted against a measured literal — EXACTLY where the
 *    population is a count of defects, and as a FLOOR where it is a count of something the register
 *    is trying to grow, so that improving the register cannot fail a close.
 *  - RUNNING ORDER, read from the close procedure itself. This one is here because gate (a) reads
 *    its baseline from the doc lane's HEAD: a filing committed BEFORE this script runs is already
 *    the baseline, so gate (a) finds nothing new and passes on an empty population instead of
 *    failing. The order is asserted from `.claude/commands/close-step.md` for that reason — a
 *    correct order with nothing testing it is a correct order until someone edits the file.
 *
 * WHAT IT REFUSES. A register the census cannot classify, a baseline git cannot answer for, and a
 * close procedure whose two steps cannot be located. All three throw rather than report zero,
 * because zero is the value that reads green: an unreadable file has an empty population, a missing
 * baseline makes every item in the file look newly filed, and an unlocatable step makes the running
 * order unassertable. The alternative — carry on with the counts that remain plausible — is the
 * fail-open this module exists to prevent.
 *
 * Run:  node --import tsx scripts/project/verify-register.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RegisterRefusal,
  bareAnchoredLiveIds,
  censusDebtItems,
  censusDebtItemsFromText,
  committedRegister,
  measureRegister,
  newlyFiledWithoutStepAnchor,
  summariseRegister,
  type DebtItem,
  type RegisterBound,
  type RegisterMeasurement,
} from "./register-census";

const DOC_LANE = "docs";
const REGISTER_IN_DOC_REPO = "project/open-debt.md";
const DECISION_LOG_IN_DOC_REPO = "project/decision-log.md";
const CLOSE_STEP_IN_DOC_REPO = ".claude/commands/close-step.md";

const REGISTER = join(DOC_LANE, REGISTER_IN_DOC_REPO);
const DECISION_LOG = join(DOC_LANE, DECISION_LOG_IN_DOC_REPO);
const CLOSE_STEP = join(DOC_LANE, CLOSE_STEP_IN_DOC_REPO);

let failures = 0;

const check = (held: boolean, label: string): void => {
  console.log(`  ${held ? "PASS" : "FAIL"}  ${label}`);
  if (!held) failures += 1;
};

/**
 * Every anchorless live id, one per line, so a red ratchet names what it counted.
 *
 * A number that fails without its members is a number the reader has to re-derive by hand, which is
 * exactly the work this script exists to remove.
 */
const listIds = (ids: string[]): void => {
  for (const id of ids) console.log(`          ${id}`);
};

/**
 * How a measurement departed from its bound, in words that say what to do about it.
 *
 * The exact kind carries the same instruction in both directions — the literal follows the number,
 * so debt paid down cannot quietly leave headroom for new debt. The floor kind cannot fail upward,
 * so a rise is reported with the edit that would keep the floor tight; the fall is the failure, and
 * it says so, because that is the direction that loses coverage without saying so.
 */
const departure = (direction: RegisterBound, measured: number, bound: number): string => {
  if (measured === bound) return "";
  const up = measured > bound;
  const moved = Math.abs(measured - bound);

  if (direction === "floor") {
    return up ? `  (up ${moved} — raise the bound to ${measured})` : `  (down ${moved} — below the floor of ${bound})`;
  }
  return up ? `  (up ${moved})` : `  (down ${moved} — lower the literal to ${measured})`;
};

/**
 * One obligation, asserted or merely reported.
 *
 * A null bound means the register states this number rather than asserting it: the item is filed
 * and no ruling has said which value is right, so a close must not be allowed to fail on it. It is
 * still measured and still printed — a number the reader can see is the part that matters, and the
 * reason it is not a pass or a fail is carried in the obligation itself.
 */
const reportObligation = ({ obligation, measured, members }: RegisterMeasurement): void => {
  const bound = obligation.bound;

  if (bound === null) {
    console.log(`  INFO  ${measured}  ${obligation.what}  (filed, not asserted)`);
    return;
  }

  const direction = obligation.direction;
  const held = direction === "floor" ? measured >= bound : measured === bound;

  check(held, `${measured}  ${obligation.what}${departure(direction, measured, bound)}`);
  listIds([...members]);
};

/** Where the close procedure runs its two steps. */
type RunningOrder = {
  gateLine: number;
  commitLine: number;
};

const GATE_INVOCATION = "npm run verify:register";
const COMMIT_INVOCATION = "cd docs && git add -A && git commit";

/**
 * The line each step sits on in the close procedure, refusing when either cannot be found.
 *
 * Both markers are the actual commands the procedure runs, not prose about them, so a step that is
 * rewritten to do something else stops being found and is refused rather than silently passing.
 * That refusal is the point: a procedure this script cannot read is a procedure whose order this
 * script cannot vouch for, and vouchsafing nothing while printing PASS is the failure gate (a) has
 * already demonstrated once in this block.
 */
const runningOrder = (file: string): RunningOrder => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RegisterRefusal(file, 0, "the close procedure could not be read");
  }

  const lines = text.split("\n");
  const gateLine = lines.findIndex((line) => line.includes(GATE_INVOCATION)) + 1;
  const commitLine = lines.findIndex((line) => line.includes(COMMIT_INVOCATION)) + 1;

  if (gateLine === 0 || commitLine === 0) {
    const missing = gateLine === 0 ? GATE_INVOCATION : COMMIT_INVOCATION;
    throw new RegisterRefusal(file, 0, `the close procedure states no step running \`${missing}\``);
  }

  return { gateLine, commitLine };
};

const main = (): void => {
  let items: DebtItem[];
  let measurements: RegisterMeasurement[];
  let baseline: { revision: string; text: string };
  let order: RunningOrder;

  try {
    items = censusDebtItems(REGISTER);
    measurements = measureRegister(REGISTER, DECISION_LOG);
    baseline = committedRegister(DOC_LANE, REGISTER_IN_DOC_REPO);
    order = runningOrder(CLOSE_STEP);
  } catch (error) {
    if (!(error instanceof RegisterRefusal)) throw error;
    console.error(`\nFAIL: ${error.message}\n`);
    console.error(
      "An instrument that cannot read its subject reports a population smaller than it claims.\n" +
        "Refusing is the point: a skipped item leaves the population without saying so.",
    );
    process.exit(1);
  }

  const summary = summariseRegister(items);
  const run = `node --import tsx scripts/project/verify-register.ts`;

  console.log("register gate");
  console.log(`  register          ${REGISTER}`);
  console.log(`  decision log      ${DECISION_LOG}`);
  console.log(`  baseline          ${DOC_LANE}@${baseline.revision} (${REGISTER_IN_DOC_REPO})`);
  console.log(`  items             ${summary.items}`);
  console.log(`  live ids          ${summary.live}  (${summary.liveEntries} entries)`);
  console.log(`  anchored live     ${summary.canonicalAnchoredLive}`);
  console.log(`  bare anchored     ${summary.bareAnchoredLive}`);
  console.log(`  anchorless live   ${summary.anchorlessLive}  (${summary.anchorlessLiveEntries} entries)`);
  console.log(`  measured by       ${run}`);

  const before = censusDebtItemsFromText(baseline.text, REGISTER_IN_DOC_REPO);
  const newlyFiled = newlyFiledWithoutStepAnchor(before, items);

  console.log("\ngates");
  check(
    newlyFiled.length === 0,
    `a live item filed since ${DOC_LANE}@${baseline.revision} names a step ` +
      `(${newlyFiled.length} filed)`,
  );
  listIds(newlyFiled.map((item) => `${item.id}:${item.line}`));

  const bare = bareAnchoredLiveIds(items);
  check(bare.length === 0, `no live item names a block without naming a step (${bare.length})`);
  listIds(bare);

  console.log("\nrunning order");
  check(
    order.gateLine < order.commitLine,
    `${CLOSE_STEP_IN_DOC_REPO} runs the gate at :${order.gateLine} before the doc-lane commit ` +
      `at :${order.commitLine}`,
  );

  console.log("\nobligations");
  for (const measurement of measurements) reportObligation(measurement);

  console.log(`\n${failures === 0 ? "ALL REGISTER CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
