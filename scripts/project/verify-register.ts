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
 * FOUR INSTRUMENTS, THREE SHAPES, deliberately not one:
 *
 *  - GATE (a), newly filed items only. An item the close under processing files must carry an anchor
 *    naming a step. Its population comes from the doc lane's own last commit, so it needs no pinned
 *    literal and never fails on debt that was already there. This is what stops the bleeding.
 *  - GATE (b), the whole file. No live item may name a block without naming a step.
 *  - OBLIGATIONS, the whole file, each asserted EXACTLY against a measured literal. A ceiling cannot
 *    make an anchorless item impossible; it puts the number on one line a reviewer reads in the
 *    diff, so adding one is a deliberate edit to a stated number and repairing one forces that
 *    number down in the same commit.
 *
 * WHAT IT REFUSES. A register the census cannot classify, and a baseline git cannot answer for. Both
 * throw rather than report zero, because zero is the value that reads green: an unreadable file has
 * an empty population, and a missing baseline makes every item in the file look newly filed. The
 * alternative — carry on with the counts that remain plausible — is the fail-open this module exists
 * to prevent.
 *
 * Run:  node --import tsx scripts/project/verify-register.ts
 */

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
  type RegisterMeasurement,
} from "./register-census";

const DOC_LANE = "docs";
const REGISTER_IN_DOC_REPO = "project/open-debt.md";
const DECISION_LOG_IN_DOC_REPO = "project/decision-log.md";

const REGISTER = join(DOC_LANE, REGISTER_IN_DOC_REPO);
const DECISION_LOG = join(DOC_LANE, DECISION_LOG_IN_DOC_REPO);

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

const reportObligation = ({ obligation, measured }: RegisterMeasurement): void => {
  const direction =
    measured === obligation.ceiling ? ""
    : measured > obligation.ceiling ? `  (up ${measured - obligation.ceiling})`
    : `  (down ${obligation.ceiling - measured} — lower the literal to ${measured})`;

  check(measured === obligation.ceiling, `${measured}  ${obligation.what}${direction}`);
};

const main = (): void => {
  let items: DebtItem[];
  let measurements: RegisterMeasurement[];
  let baseline: { revision: string; text: string };

  try {
    items = censusDebtItems(REGISTER);
    measurements = measureRegister(REGISTER, DECISION_LOG);
    baseline = committedRegister(DOC_LANE, REGISTER_IN_DOC_REPO);
  } catch (error) {
    if (!(error instanceof RegisterRefusal)) throw error;
    console.error(`\nFAIL: ${error.message}\n`);
    console.error(
      "The register cannot be classified, so every count below it would measure less than it\n" +
        "claims. Refusing is the point: a skipped item leaves the population without saying so.",
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

  console.log("\nobligations");
  for (const measurement of measurements) reportObligation(measurement);

  console.log(`\n${failures === 0 ? "ALL REGISTER CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
