/**
 * Moves finished entries out of `open-debt.md` into `open-debt-archive.md`.
 *
 * Check:  node --import tsx scripts/project/register-sweep.ts [--check] [--date YYYY-MM-DD] [--docs <dir>]
 * Apply:  node --import tsx scripts/project/register-sweep.ts --write [--date YYYY-MM-DD] [--docs <dir>]
 *
 * `--check` is the default. It writes nothing and exits 1 when a sweep would change anything.
 *
 * WHAT MOVES. An entry whose id has no live entry anywhere in the live file, and a non-register-id
 * bullet under a `### Discharged`, `### Fixed` or `### Withdrawn` heading. An id with any live entry
 * keeps every entry it has, so no open item is ever separated from its history. Learnings bullets and
 * every other prose bullet stay. A `###` heading the move leaves empty is removed. A `##` block that
 * holds no entry and no skipped bullet after the move goes whole, prose and all.
 *
 * WHY THE GATE CANNOT TELL. The register gate measures both files as one population, and every
 * population it reads is a set over ids. Moving whole ids keeps each set what it was, and the sweep
 * proves that on its own output before it writes: a plan whose two texts do not measure like the
 * original two is refused.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DecisionRefusal, docsDirectory } from "./decision-files";
import {
  RegisterRefusal,
  censusDebtItemsFromText,
  censusSkippedBulletsFromText,
  readRegister,
  type DebtItem,
  type SkippedBullet,
} from "./register-census";

export const REGISTER_IN_DOCS = "project/open-debt.md";
export const ARCHIVE_IN_DOCS = "archive/project/open-debt-archive.md";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The `###` kinds whose non-register-id bullets are finished work rather than prose. */
const FINISHED_SECTION = /^### (Discharged|Fixed|Withdrawn)\b/;

const RULE_LINE = /^-{3,}\s*$/;
const HEADING_LINE = /^#{1,6} /;

export type SweepPlan = {
  live: string;
  archive: string;
  entriesMoved: number;
  bulletsMoved: number;
  headingsRemoved: number;
  blocksRemoved: number;
};

/** A run of lines that moves, as 0-based indices with `last` inclusive. */
type Movable = {
  kind: "entry" | "bullet";
  first: number;
  last: number;
  /** Index of the `##` line the run sits under. */
  block: number;
  /** Index of the `###` line the run sits under; -1 when it sits in the block body. */
  section: number;
};

/** Where every line sits, and where each `##` block and `###` section ends (exclusive). */
type Layout = {
  blockOf: number[];
  sectionOf: number[];
  blockEnd: Map<number, number>;
  sectionEnd: Map<number, number>;
};

function layoutOf(lines: string[]): Layout {
  const blockOf: number[] = [];
  const sectionOf: number[] = [];
  const blockEnd = new Map<number, number>();
  const sectionEnd = new Map<number, number>();
  let block = -1;
  let section = -1;

  lines.forEach((raw, index) => {
    const opensBlock = raw.startsWith("## ");
    const opensSection = raw.startsWith("### ");
    if (opensBlock && block !== -1) blockEnd.set(block, index);
    if ((opensBlock || opensSection) && section !== -1) sectionEnd.set(section, index);
    if (opensBlock) {
      block = index;
      section = -1;
    }
    if (opensSection) section = index;
    blockOf.push(block);
    sectionOf.push(section);
  });

  if (block !== -1) blockEnd.set(block, lines.length);
  if (section !== -1) sectionEnd.set(section, lines.length);
  return { blockOf, sectionOf, blockEnd, sectionEnd };
}

function movableRuns(
  lines: string[],
  layout: Layout,
  items: DebtItem[],
  skipped: SkippedBullet[],
): Movable[] {
  const idsWithLiveEntry = new Set(items.filter((item) => item.live).map((item) => item.id));
  const runs: Movable[] = [];

  for (const item of items) {
    if (idsWithLiveEntry.has(item.id)) continue;
    runs.push(runOf("entry", item.line, item.endLine, layout));
  }
  for (const bullet of skipped) {
    const heading = lines[layout.sectionOf[bullet.line - 1] ?? -1] ?? "";
    if (!FINISHED_SECTION.test(heading.trim())) continue;
    runs.push(runOf("bullet", bullet.line, bullet.endLine, layout));
  }

  // An entry above the first `##` heading has no block heading to replicate in the archive.
  return runs.filter((run) => run.block !== -1).sort((a, b) => a.first - b.first);
}

function runOf(kind: Movable["kind"], line: number, endLine: number, layout: Layout): Movable {
  const first = line - 1;
  return {
    kind,
    first,
    last: endLine - 1,
    block: layout.blockOf[first] ?? -1,
    section: layout.sectionOf[first] ?? -1,
  };
}

/** The `##` blocks the move touches that are left holding no entry and no skipped bullet. */
function blocksLeftEmpty(
  layout: Layout,
  moved: Movable[],
  items: DebtItem[],
  skipped: SkippedBullet[],
): Set<number> {
  const movedFirsts = new Set(moved.map((run) => run.first));
  const stillHolding = new Set<number>();
  for (const held of [...items, ...skipped]) {
    if (movedFirsts.has(held.line - 1)) continue;
    stillHolding.add(layout.blockOf[held.line - 1] ?? -1);
  }
  const touched = new Set(moved.map((run) => run.block));
  return new Set([...touched].filter((block) => !stillHolding.has(block)));
}

/** The `###` headings of partly moved blocks that the move leaves with nothing under them. */
function emptiedSections(
  lines: string[],
  layout: Layout,
  moved: Movable[],
  removed: boolean[],
  wholeBlocks: Set<number>,
): number[] {
  const touched = moved
    .filter((run) => run.section !== -1 && !wholeBlocks.has(run.block))
    .map((run) => run.section);

  return [...new Set(touched)].filter((section) => {
    const end = layout.sectionEnd.get(section) ?? lines.length;
    for (let index = section + 1; index < end; index += 1) {
      const raw = lines[index] ?? "";
      if (removed[index] === true || raw.trim() === "" || RULE_LINE.test(raw)) continue;
      return false;
    }
    return true;
  });
}

function entryText(lines: string[], run: Movable): string {
  return lines.slice(run.first, run.last + 1).join("\n");
}

/** A removed block as it stood, from its heading to its last line that is not blank. */
function wholeBlockText(lines: string[], layout: Layout, block: number): string {
  const end = layout.blockEnd.get(block) ?? lines.length;
  const text = lines.slice(block, end);
  while (text.length > 0 && (text[text.length - 1] ?? "").trim() === "") text.pop();
  return text.join("\n");
}

/** A partly moved block: its heading, then each affected section's heading and moved entries. */
function partialBlockText(lines: string[], moved: Movable[], block: number): string {
  const inBlock = moved.filter((run) => run.block === block);
  const sections = [...new Set(inBlock.map((run) => run.section))].sort((a, b) => a - b);
  const parts = [lines[block] ?? ""];

  for (const section of sections) {
    if (section !== -1) parts.push(lines[section] ?? "");
    const inSection = inBlock.filter((run) => run.section === section);
    parts.push(...inSection.map((run) => entryText(lines, run)));
  }
  return parts.join("\n\n");
}

const batchComment = (date: string): string => `<!-- swept ${date} -->`;

function renderBatch(
  lines: string[],
  layout: Layout,
  moved: Movable[],
  wholeBlocks: Set<number>,
  date: string,
): string {
  const blocks = [...new Set(moved.map((run) => run.block))].sort((a, b) => a - b);
  const pieces = blocks.map((block) =>
    wholeBlocks.has(block)
      ? wholeBlockText(lines, layout, block)
      : partialBlockText(lines, moved, block),
  );
  return `${[batchComment(date), ...pieces].join("\n\n")}\n`;
}

/**
 * The lines that stay, with the blank lines a removal leaves doubled collapsed to one.
 *
 * Only a blank that directly follows a removed line is dropped, so blank runs the sweep did not
 * touch are kept as they were.
 */
function keptLines(lines: string[], removed: boolean[]): string[] {
  const kept: string[] = [];
  let afterRemoval = false;

  lines.forEach((raw, index) => {
    if (removed[index] === true) {
      afterRemoval = true;
      return;
    }
    const previous = kept[kept.length - 1];
    const doubledBlank = raw.trim() === "" && (previous === undefined || previous.trim() === "");
    if (doubledBlank && afterRemoval) return;
    kept.push(raw);
    afterRemoval = false;
  });
  return kept;
}

/** Every line that is neither blank nor a heading, counted, so a lost or invented line shows. */
function proseLineCounts(...texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      if (raw.trim() === "" || HEADING_LINE.test(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  return counts;
}

/** What the gate reads of every entry and bullet in `texts`, one string each, sorted. */
function measuredSignature(live: string, archive: string): string[] {
  const items = [
    ...censusDebtItemsFromText(live, REGISTER_IN_DOCS),
    ...censusDebtItemsFromText(archive, ARCHIVE_IN_DOCS),
  ].map((item) =>
    [
      "entry",
      item.id,
      item.block,
      item.section,
      item.severity,
      item.anchor,
      item.live,
      item.discharged,
      item.withdrawn,
    ].join("\u0000"),
  );
  const bullets = [
    ...censusSkippedBulletsFromText(live, REGISTER_IN_DOCS),
    ...censusSkippedBulletsFromText(archive, ARCHIVE_IN_DOCS),
  ].map((bullet) => ["bullet", bullet.id].join("\u0000"));
  return [...items, ...bullets].sort();
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [raw, count] of a) {
    if (b.get(raw) !== count) return false;
  }
  return true;
}

/**
 * Refuses a plan whose two texts do not read like the two it came from.
 *
 * Two properties, because either alone can hold while the other breaks. The census must measure the
 * same entries with the same ids, sections, anchors and marks. And no prose line may be lost or
 * invented: every line that is not blank or a heading appears exactly as often as before, plus the
 * batch comment.
 */
function refuseUnsoundPlan(
  before: { live: string; archive: string },
  plan: SweepPlan,
  date: string,
): void {
  const measuredAlike =
    measuredSignature(before.live, before.archive).join("\n") ===
    measuredSignature(plan.live, plan.archive).join("\n");
  if (!measuredAlike) {
    throw new RegisterRefusal(
      REGISTER_IN_DOCS,
      0,
      "the sweep's output does not measure like its input",
    );
  }

  const moved = plan.entriesMoved + plan.bulletsMoved > 0;
  const expected = proseLineCounts(
    before.live,
    before.archive,
    ...(moved ? [batchComment(date)] : []),
  );
  const actual = proseLineCounts(plan.live, plan.archive);
  if (!sameCounts(expected, actual)) {
    throw new RegisterRefusal(REGISTER_IN_DOCS, 0, "the sweep's output lost or invented a line");
  }
}

type Planner = (liveText: string, archiveText: string, date: string) => SweepPlan;

/**
 * The plan for sweeping `liveText` into `archiveText`, before anything has checked it.
 *
 * Nothing movable returns both texts as they came in, which is what makes a second run a no-op.
 */
const buildSweep: Planner = (liveText, archiveText, date) => {
  const items = censusDebtItemsFromText(liveText, REGISTER_IN_DOCS);
  const skipped = censusSkippedBulletsFromText(liveText, REGISTER_IN_DOCS);
  const lines = liveText.split("\n");
  const layout = layoutOf(lines);
  const moved = movableRuns(lines, layout, items, skipped);

  if (moved.length === 0) {
    return {
      live: liveText,
      archive: archiveText,
      entriesMoved: 0,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    };
  }

  const wholeBlocks = blocksLeftEmpty(layout, moved, items, skipped);
  const removed = lines.map(() => false);
  for (const block of wholeBlocks) {
    const end = layout.blockEnd.get(block) ?? lines.length;
    for (let index = block; index < end; index += 1) removed[index] = true;
  }
  for (const run of moved) {
    for (let index = run.first; index <= run.last; index += 1) removed[index] = true;
  }
  const emptied = emptiedSections(lines, layout, moved, removed, wholeBlocks);
  for (const section of emptied) removed[section] = true;

  const batch = renderBatch(lines, layout, moved, wholeBlocks, date);
  const archiveBase =
    archiveText === "" || archiveText.endsWith("\n") ? archiveText : `${archiveText}\n`;
  const keptText = keptLines(lines, removed).join("\n");
  const plan: SweepPlan = {
    live: liveText.endsWith("\n") && !keptText.endsWith("\n") ? `${keptText}\n` : keptText,
    archive: `${archiveBase}\n${batch}`,
    entriesMoved: moved.filter((run) => run.kind === "entry").length,
    bulletsMoved: moved.filter((run) => run.kind === "bullet").length,
    headingsRemoved: emptied.length,
    blocksRemoved: wholeBlocks.size,
  };

  return plan;
};

/**
 * What a sweep of `liveText` into `archiveText` produces, without touching either file.
 *
 * Throws `RegisterRefusal` for text the census cannot classify, for a date that is not
 * `YYYY-MM-DD`, and for a plan that fails its own check. `build` is the planner under that check;
 * it is a parameter so a test can hand the check a plan that is wrong.
 */
export function planSweep(
  liveText: string,
  archiveText: string,
  date: string,
  build: Planner = buildSweep,
): SweepPlan {
  if (!DATE.test(date)) {
    throw new RegisterRefusal("--date", 0, `${JSON.stringify(date)} is not YYYY-MM-DD`);
  }
  censusDebtItemsFromText(archiveText, ARCHIVE_IN_DOCS);
  censusSkippedBulletsFromText(archiveText, ARCHIVE_IN_DOCS);

  const plan = build(liveText, archiveText, date);
  refuseUnsoundPlan({ live: liveText, archive: archiveText }, plan, date);
  return plan;
}

const ARGUMENTS_WITH_A_VALUE = new Set(["--date", "--docs"]);
const KNOWN_ARGUMENTS = new Set(["--check", "--write", ...ARGUMENTS_WITH_A_VALUE]);

function refuseUnknownArguments(argv: string[]): void {
  argv.forEach((argument, index) => {
    const isValue = ARGUMENTS_WITH_A_VALUE.has(argv[index - 1] ?? "");
    if (isValue || KNOWN_ARGUMENTS.has(argument)) return;
    throw new DecisionRefusal(argument, "is not an argument register:sweep takes");
  });
}

// `sv-SE` prints the date in year-month-day order, in the machine's own time zone.
const today = (): string => new Date().toLocaleDateString("sv-SE");

function dateArgument(argv: string[]): string {
  const at = argv.indexOf("--date");
  if (at === -1) return today();
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DecisionRefusal("--date", "needs a date");
  }
  return value;
}

const describe = (plan: SweepPlan): string =>
  `${plan.entriesMoved} entries and ${plan.bulletsMoved} skipped bullets moved, ` +
  `${plan.headingsRemoved} headings and ${plan.blocksRemoved} blocks removed`;

const main = (): void => {
  const argv = process.argv.slice(2);
  try {
    refuseUnknownArguments(argv);
    const write = argv.includes("--write");
    if (write && argv.includes("--check")) {
      throw new DecisionRefusal("--write", "cannot be combined with --check");
    }
    const docs = docsDirectory(process.argv);
    const date = dateArgument(argv);
    const livePath = join(docs, REGISTER_IN_DOCS);
    const archivePath = join(docs, ARCHIVE_IN_DOCS);
    const plan = planSweep(readRegister(livePath), readRegister(archivePath), date);
    const pending = plan.entriesMoved + plan.bulletsMoved > 0;

    if (!pending) {
      console.log(`register:sweep  nothing to sweep in ${livePath}`);
      return;
    }
    if (!write) {
      console.error(`FAIL: a sweep is pending: ${describe(plan)}`);
      process.exit(1);
    }
    // The archive is written first: a failure between the two writes leaves entries in both files,
    // which the gate's item count shows, instead of in neither.
    writeFileSync(archivePath, plan.archive);
    writeFileSync(livePath, plan.live);
    console.log(`register:sweep  ${describe(plan)} (${archivePath})`);
  } catch (error) {
    if (!(error instanceof RegisterRefusal) && !(error instanceof DecisionRefusal)) throw error;
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
