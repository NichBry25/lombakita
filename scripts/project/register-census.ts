import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The census of the two project registers.
 *
 * A debt line and a decision row are both a fixed shape that a reader — human or grep — relies on
 * without knowing they rely on it. This module reads those shapes structurally and returns them as
 * data, so that an assertion about them measures the file rather than restating an assumption about
 * it.
 *
 * WHAT "STRUCTURALLY" MEANS HERE, because it is the whole substance:
 *
 *  - A debt item is a markdown paragraph whose first line opens `- ` and whose bold run opens with
 *    an id of the register's own series. The register writes items across several lines and the
 *    bold run can close on a later line than it opens, so the unit is the whole paragraph — reading
 *    only the first line truncates the severity bracket or the bold run and misclassifies the item.
 *    A `- ` line whose bold head is prose is not an item.
 *  - An ANCHOR is the `→` that OPENS the item's remainder: the first non-whitespace character after
 *    the id and its severity bracket. Position is what separates a destination from an arrow in
 *    prose. The register also writes `→` inside a status bracket (`[PARTIAL → minimum surfacing
 *    landed]`), inside a downgrade description (`full→personal`), and inside sentences, and every
 *    one of those arrows points at nothing — reading one as an anchor would credit an item with a
 *    destination it has never been given. Measured at seven items on the register as it stands.
 *  - SEVERITY is the bracket's own content, verbatim.
 *
 * WHAT IT REFUSES, and why refusing is the right failure. A paragraph whose bold never closes, or
 * whose severity bracket never closes, cannot be classified — the census cannot say whether the
 * rest of it is anchor, prose or both, and every later count depends on the answer.
 * `RegisterRefusal` is thrown for those. The alternative — treating the paragraph as prose and
 * carrying on — is fail-open: the counts stay plausible, the file stops being fully covered, and
 * nothing says so.
 *
 * This mirrors `scripts/seed/routing-census.ts`, which refused an unclassifiable write site for the
 * same reason and in the same shape.
 */

export class RegisterRefusal extends Error {
  constructor(file: string, line: number, reason: string) {
    super(`the census refuses ${file}:${line}: ${reason}`);
    this.name = "RegisterRefusal";
  }
}

/** A `- **ID [severity]** → anchor` line, classified. */
export type DebtItem = {
  file: string;
  line: number;
  /** The id as written. */
  id: string;
  /** The severity bracket's content verbatim; empty when the item carries no bracket. */
  severity: string;
  /** The `##` heading the item sits under. */
  block: string;
  /** The `###` heading the item sits under; empty when the item sits in the block body. */
  section: string;
  /** The anchor text opening at the `→` that opens the item's remainder; null when no `→` does. */
  anchor: string | null;
  /** The anchor names a block but no step, e.g. `→ Block D`. */
  anchorIsBareBlock: boolean;
  /** The anchor names a step, e.g. `→ Step 7.7.` or `→ Step 7.7 Block C`. */
  anchorNamesStep: boolean;
  /** The item's own line carries the discharge mark. */
  discharged: boolean;
  /** The item's own line carries the withdrawal mark. */
  withdrawn: boolean;
  /** The item is open work by either arm of `isLiveItem`, and carries neither mark. */
  live: boolean;
};

const HEAD = /^- \*\*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[([^\]]*)\])?/;

/**
 * The register's id series: a prefix, then `-D<digits>` for debt or `-T<digits>` for a test gap.
 * A `- ` line that does not open with one of these is prose — the register writes its evidence
 * inline as bold lead-ins — and is not an item.
 */
const REGISTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*-[DT]\d+$/;

/**
 * Whether `line` ends the item above it.
 *
 * An item is a markdown paragraph: its head line plus every following line that neither is blank
 * nor opens a new block. This is the whole reason the census reads paragraphs rather than lines —
 * the register writes the severity bracket and the closing `**` on later lines often enough that a
 * line-at-a-time reader misclassifies real items.
 */
function endsItem(line: string): boolean {
  if (line.trim() === "") return true;
  if (/^#{1,6} /.test(line)) return true;
  if (/^-{3,}\s*$/.test(line)) return true;
  return line.startsWith("- ");
}

const LIVE_SECTION = /^### (Open|Still open|New)\b/;

const DISCHARGED_SECTION = /^### Discharged\b/;

/**
 * A severity bracket's content, which is a closed set and not "whatever the bracket holds".
 *
 * Arm (b) of `isLiveItem` keys on this, and the register writes brackets that are not severities all
 * over its live work: `[NEW-TEST]`, `[VERIFIED 2026-08-06]`, `[MOSTLY DISCHARGED 2026-08-03]`,
 * `[PARTIAL → minimum surfacing landed]`, `[DESIGN]`. A bracket the register uses for anything else
 * states something other than severity, so an item carrying one is not live by this arm — which is
 * the direction that keeps this arm from sweeping in prose the register never filed as debt.
 */
const SEVERITY_TOKEN = /^(HIGH|MEDIUM|LOW|PROCESS)$/;

/**
 * The `###` headings that keep an item out of arm (b) however it is written.
 *
 * A block-body item carries its severity and its anchor, and for the debt blocks that is the whole
 * statement — but a heading that names a disposition states the opposite about everything under it.
 * `Withdrawn — do not carry` is the register saying so in words; `Discharged`, `Fixed` and
 * `Learnings` are the census's own three kinds. The test is the heading's KIND and not a list of
 * headings, so a new section of any of the four kinds is covered the day it is written.
 */
const DISPOSITION_SECTION = /^### (Discharged|Withdrawn|Learnings|Fixed)\b/;

/**
 * The register's second item-level disposition mark.
 *
 * The difference from `DISCHARGE_MARK` is one the file itself forces rather than a preference:
 * LAUNCH-D143 writes it plain (`→ Step 7.7 Block C2 (Phase 2) · WITHDRAWN 2026-09-22, premise
 * false.`) and LAUNCH-D89 writes it inside a bold run (`→ Step 7.7 Block D · **WITHDRAWN
 * 2026-09-15, filed in error.**`). To a reader those are the same mark, so they have to be the same
 * mark here, or the census counts one of two identically-marked items as live.
 */
const WITHDRAWAL_MARK = /·\s*\*{0,2}\s*WITHDRAWN/;

/**
 * Whether an item is open work — the predicate every live population is a set over.
 *
 * TWO ARMS, because the register files its open work in two shapes and the census counted one.
 *
 *  - (a) The item sits under a `###` heading of the live kind (`Open`, `Still open`, `New`). This is
 *    what the census has always read, and it stays exactly as it was.
 *  - (b) The item carries a SEVERITY bracket and an anchor of its own, wherever it sits — which in
 *    practice is the body of a `## Known Debt (…)` block. Before this arm existed, an item filed
 *    there was in no live population at all: it was not counted, not listed by any red ratchet, and
 *    not reachable by the gate whose whole subject is which items are open. Arm (b) is deliberately
 *    narrower than "not under a discharge heading": it requires BOTH the severity and the anchor, so
 *    a prose bullet the register files inside a debt block is not swept into the live set by a
 *    heading it happens to sit under.
 *
 * BOTH ARMS YIELD TO A MARK. An item whose own declaration line carries `· DISCHARGED` or
 * `· WITHDRAWN` is not live whichever arm would otherwise reach it — the mark is the register saying
 * the item is closed, and an arm that outranked it would count closed work as open.
 *
 * `WITHDRAWN` is its own mark and NOT a kind of discharged: it takes the item out of the live set,
 * and it does not answer the separate obligation that asks which items a DISCHARGE SECTION declares
 * discharged while their anchor line says nothing — `discharged` above is that field, and it stays
 * DISCHARGED-only.
 */
function isLiveItem(
  item: Pick<DebtItem, "section" | "severity" | "discharged" | "withdrawn"> & {
    anchored: boolean;
  },
): boolean {
  if (item.discharged || item.withdrawn) return false;
  if (LIVE_SECTION.test(item.section)) return true;
  return (
    SEVERITY_TOKEN.test(item.severity) && item.anchored && !DISPOSITION_SECTION.test(item.section)
  );
}

/**
 * A `Learnings` subsection, which files prose lessons rather than debt items.
 *
 * Its bullets never carried ids and were never meant to, so reading their head token as a failed id
 * measures the punctuation each one happens to open with: a bullet opening `- **A guard whose …` is
 * read and counted, one opening ``- **`railway run` borrows …`` is not, and the difference says
 * nothing about either. The section KIND is the test rather than a list of headings, so a new
 * `Learnings` subsection is covered the day it is written.
 *
 * THE NAME IS DELIBERATELY NARROW. This matches `Learnings` and nothing else, and `Learnings` is not
 * the register's only narrative subsection: `Repository hygiene, filed at the REPO-D4 move`, `Two
 * declared absences`, `Fixed in-step after depth review`, `Two findings the step was not looking
 * for` and `Three traps, recorded so they are not re-run` all file prose bullets too, and seven of
 * them are still counted for opening with a bare word. Calling this `NARRATIVE_SECTION` would claim
 * a population it does not cover, which is the defect the count exists to expose.
 *
 * WHAT THIS COSTS, stated rather than implied: a genuinely mistyped register id written inside a
 * `Learnings` subsection is not counted and not reported. The exclusion is a hole of exactly that
 * shape and no larger, and the probe `the Learnings exclusion is exactly one bullet wide` in
 * `scripts/testing/probes/register-gate.mjs` demonstrates both of its edges in one run: it plants a
 * mistyped id in a live section and another inside a `Learnings` subsection, and requires the count
 * to move by exactly one.
 */
const LEARNINGS_SECTION = /^### Learnings\b/;

/**
 * The register's item-level disposition mark — one mark, not a list of words.
 *
 * The words are unusable as a signal because the register's evidence prose uses them while
 * describing something other than the item: "Mitigated but not closed", "AFTER the step closed",
 * "the class is NOT closed", "failing closed", "a closed `<details>`". A word list drawn from that
 * vocabulary closes three items that are all open and none that are closed, and every item outside
 * a live section whose head carries such a word is already closed by its own section heading. So
 * inside a live section the mark is the entire signal, and the mark is this one.
 */
const DISCHARGE_MARK = /·\s*DISCHARGED/;

const CANONICAL_ANCHOR = /^→\s*Step\s+[\d.]+\s+Block\s+[A-Z]\d*\b/;
const BARE_BLOCK_ANCHOR = /^→\s*Block\s+[A-Z]\d*\b/;
const NAMES_STEP = /^→\s*Step\s+[\d.]+\b/;

/**
 * A bullet the register files that the census cannot read as a debt item, with where it is.
 *
 * Not a curiosity to be tidied away: a bullet filed with a mistyped id is invisible to every grep
 * for the id the author meant, which is the failure this whole module exists to catch. Whether each
 * of these is a label that was never an id, or an id that was typed wrong, is a question about the
 * register's conventions and not a question this census can settle. So it counts them and names
 * them, and the count is asserted.
 */
export type SkippedBullet = {
  /** The head token the census read, which is what failed to be a register id. */
  id: string;
  line: number;
};

/** What one walk of the register produced. */
type RegisterWalk = {
  items: DebtItem[];
  skipped: SkippedBullet[];
};

/**
 * Reads every debt item in the register at `file`.
 *
 * Throws `RegisterRefusal` for a line it cannot classify. A missing file is refused too: this
 * census has no meaningful result over an absent register, and reporting an empty population would
 * read as "no debt".
 */
export function censusDebtItems(file: string): DebtItem[] {
  return censusRegister(readRegister(file), file).items;
}

/** The same census over text already in hand, for a caller comparing two revisions of one file. */
export function censusDebtItemsFromText(text: string, file: string): DebtItem[] {
  return censusRegister(text, file).items;
}

/**
 * The bullets this census skips because their head token is not a register id.
 *
 * Skipping is fail-open, and refusing is not available here: the register as it stands heads 32
 * bullets `- **C1**`, `- **M1 / M3**`, `- **TRAP-1: …`, `- **INCIDENT-2026-07-16 …**` and the
 * like, so a census that refused them could not be green on the file it is written over. Counting
 * them is the alternative to refusing them, and it is what turns a silent skip into a measured one.
 *
 * The walk is the SAME walk that produces the items, so this cannot drift from the population the
 * census actually leaves out.
 */
export function censusSkippedBullets(file: string): SkippedBullet[] {
  return censusRegister(readRegister(file), file).skipped;
}

/** The register's text, refusing rather than reporting an empty one. */
function readRegister(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new RegisterRefusal(file, 0, "the register could not be read");
  }
}

function censusRegister(text: string, file: string): RegisterWalk {
  const lines = text.split("\n");
  const items: DebtItem[] = [];
  const skipped: SkippedBullet[] = [];
  let block = "";
  let section = "";
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const line = index + 1;

    if (/^## /.test(raw)) {
      block = raw.trim();
      section = "";
      index += 1;
      continue;
    }
    if (/^### /.test(raw)) {
      section = raw.trim();
      index += 1;
      continue;
    }
    if (!raw.startsWith("- ")) {
      index += 1;
      continue;
    }

    const paragraph = [raw];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (endsItem(next)) break;
      paragraph.push(next);
      index += 1;
    }

    const flat = paragraph.join("\n").replace(/\s+/g, " ").trim();
    const head = HEAD.exec(flat);
    if (head === null) continue;
    const [matched, id, severity] = head;
    if (matched === undefined || id === undefined) continue;
    if (!REGISTER_ID.test(id)) {
      if (!LEARNINGS_SECTION.test(section)) {
        skipped.push({ id, line });
      }
      continue;
    }

    const openedBracket = raw.indexOf("[", 2);
    if (openedBracket !== -1 && flat.indexOf("]", openedBracket) === -1) {
      throw new RegisterRefusal(file, line, "the severity bracket is never closed");
    }

    const boldClose = flat.indexOf("**", matched.length);
    if (boldClose === -1) {
      throw new RegisterRefusal(file, line, "the bold run is never closed");
    }

    // What an item DECLARES — its anchor and any discharge mark — is written in its head line and
    // in the bold run when the bold wraps past that line. Evidence prose below routinely carries
    // `→` and the disposition words while describing something else, so neither is read from there.
    const headLine = raw.replace(/\s+/g, " ").trim();
    const headEnd = Math.max(headLine.length, boldClose);
    const declared = flat.slice(0, headEnd);

    const declaredDischarged = DISCHARGE_MARK.test(declared);
    const declaredWithdrawn = WITHDRAWAL_MARK.test(declared);
    const severityToken = severity ?? "";

    // The remainder is what follows the id and its severity bracket. Its opening character is the
    // test, and the only thing allowed between the two is the closing `**` of the bold run: the
    // register writes `- **ID [HIGH]** → Step 7.7 ...` when the bold closes with the bracket, and
    // `- **ID [HIGH] → Step 7.7 ...**` when it closes past it. Anchoring the measurement to the
    // bold close instead would lose the second form, and anchoring it to the id would invent an
    // anchor out of `[NEW-TEST]:** no component test (picker → ...`.
    const afterHead = flat.slice(matched.length);
    const remainderStart = afterHead.startsWith("**") ? matched.length + 2 : matched.length;
    const remainder = flat.slice(remainderStart);
    const anchored = /^\s*→/.test(remainder);
    const arrow = anchored ? remainderStart + remainder.indexOf("→") : -1;
    const anchor = anchored
      ? declared
          .slice(arrow, arrow + 80)
          .replace(/\*\*/g, "")
          .trim()
      : null;

    items.push({
      file,
      line,
      id,
      severity: severityToken,
      block,
      section,
      anchor,
      anchorIsBareBlock: anchor !== null && BARE_BLOCK_ANCHOR.test(anchor),
      anchorNamesStep: anchor !== null && NAMES_STEP.test(anchor),
      discharged: declaredDischarged,
      withdrawn: declaredWithdrawn,
      live: isLiveItem({
        section,
        severity: severityToken,
        anchored,
        discharged: declaredDischarged,
        withdrawn: declaredWithdrawn,
      }),
    });
  }

  return { items, skipped };
}

/**
 * The ids with at least one live entry, and the ids with at least one anchored entry.
 *
 * Every population below is a set of IDS, not of entries, because the register files some ids more
 * than once — a headline entry carrying the anchor and a detail entry restating the item, or a live
 * entry and a disposition entry under different sub-headings. Seventeen ids are filed twice today.
 * Counting entries would ask whether the DETAIL entry carries an anchor, which is not the question:
 * an item that has been given a destination has been given one, whichever of its entries says so.
 */
export function liveIds(items: DebtItem[]): string[] {
  return [...new Set(items.filter((item) => item.live).map((item) => item.id))];
}

function idsWithAnchor(items: DebtItem[]): Set<string> {
  return new Set(items.filter((item) => item.anchor !== null).map((item) => item.id));
}

/**
 * The live items whose anchor names a block and no step. Gate (b)'s population.
 *
 * An id qualifies when it is live and NO entry for it names a step — so an item whose headline
 * anchor is `→ Step 7.7 Block C` is not in this population, whatever its detail entry says.
 */
export function bareAnchoredLiveIds(items: DebtItem[]): string[] {
  const namesStep = new Set(items.filter((item) => item.anchorNamesStep).map((item) => item.id));
  return liveIds(items).filter(
    (id) => !namesStep.has(id) && items.some((item) => item.id === id && item.anchorIsBareBlock),
  );
}

/**
 * The live items carrying no anchor on any entry. The ratchet's population.
 *
 * A live id leaves this population when ANY of its entries gains an anchor — which is why the
 * ratchet moves down as the register is repaired and never up except by a deliberate edit to the
 * ceiling literal.
 */
export function anchorlessLiveIds(items: DebtItem[]): string[] {
  const anchored = idsWithAnchor(items);
  return liveIds(items).filter((id) => !anchored.has(id));
}

/**
 * The live items whose anchor names a step AND a block: the register's fully formed destinations.
 *
 * A set of IDS like every population here, so an item filed twice contributes one id whichever of
 * its entries carries the anchor. Nothing is computed for this that the file view was not already
 * printing — it is the register's practising half, and it RISES as anchors are canonicalised, which
 * is why it is asserted as a floor: an improvement must not fail a close.
 */
export function canonicalAnchoredLiveIds(items: DebtItem[]): string[] {
  return [
    ...new Set(
      items
        .filter((item) => item.live && item.anchor !== null && CANONICAL_ANCHOR.test(item.anchor))
        .map((item) => item.id),
    ),
  ];
}

/**
 * The live items filed by `after` that `before` did not hold, and that carry no anchor naming a
 * step. Gate (a)'s population: this is the bleeding, not the wound.
 *
 * Identity is the id, so an item that merely moved lines is not newly filed, and an item whose id
 * already existed is not re-judged here — pre-existing debt is the ratchet's business.
 */
export function newlyFiledWithoutStepAnchor(before: DebtItem[], after: DebtItem[]): DebtItem[] {
  const known = new Set(before.map((item) => item.id));
  const namesStep = new Set(after.filter((item) => item.anchorNamesStep).map((item) => item.id));
  return after.filter((item) => item.live && !known.has(item.id) && !namesStep.has(item.id));
}

/**
 * The items a discharge section declares discharged whose own anchor line does not say so.
 *
 * The population is derived, not listed: an id is in it when some entry for that id sits under a
 * `### Discharged` heading AND some other entry for the same id carries an anchor. An id that only
 * ever appears inside the discharge section has no anchor line to mark and is not this gate's.
 */
export function dischargedWithoutMark(items: DebtItem[]): DebtItem[] {
  const declared = new Set(
    items.filter((item) => DISCHARGED_SECTION.test(item.section)).map((item) => item.id),
  );
  const unmarked: DebtItem[] = [];
  for (const id of declared) {
    const anchored = items.filter((item) => item.id === id && item.anchor !== null);
    const first = anchored[0];
    if (first === undefined) continue;
    if (anchored.every((item) => !item.discharged)) unmarked.push(first);
  }
  return unmarked;
}

// ---------------------------------------------------------------------------------------------
// The decision log
// ---------------------------------------------------------------------------------------------

export type DecisionRow = {
  file: string;
  line: number;
  id: string;
  /** Every cell as markdown actually separates it, which is what a reader sees. */
  cells: string[];
};

export type DecisionTable = {
  file: string;
  /** The `##` heading the table sits under. */
  heading: string;
  line: number;
  columns: string[];
  rows: DecisionRow[];
};

const TABLE_DELIMITER = /^\|[\s:|-]+\|$/;
const TABLE_ROW = /^\|/;

/**
 * Splits a table row into cells the way markdown does.
 *
 * `\|` inside a cell is an escaped pipe and is CONTENT, not a separator. Splitting on every pipe
 * regardless — which is what a reader skimming the raw markdown does — invents columns that the
 * table does not declare and silently truncates the cell the pipe sat in. That difference is the
 * defect this census exists to find, so the split has to be the correct one.
 */
function splitRow(raw: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\" && raw[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char !== "|") {
      cell += char;
      continue;
    }
    cells.push(cell.trim());
    cell = "";
  }
  if (!raw.endsWith("|")) cells.push(cell.trim());
  return cells;
}

export function censusDecisionLog(file: string): DecisionTable[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RegisterRefusal(file, 0, "the decision log could not be read");
  }
  return censusDecisionLogFromText(text, file);
}

export function censusDecisionLogFromText(text: string, file: string): DecisionTable[] {
  const lines = text.split("\n");
  const tables: DecisionTable[] = [];
  let heading = "";

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (/^## /.test(raw)) {
      heading = raw.trim();
      continue;
    }
    if (!TABLE_ROW.test(raw) || !TABLE_DELIMITER.test(lines[index + 1] ?? "")) continue;

    const columns = splitRow(raw);
    const rows: DecisionRow[] = [];
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      const row = lines[cursor] ?? "";
      if (!TABLE_ROW.test(row)) break;
      const cells = splitRow(row);
      rows.push({ file, line: cursor + 1, id: cells[0] ?? "", cells });
    }
    tables.push({ file, heading, line: index + 1, columns, rows });
    index += rows.length + 1;
  }

  return tables;
}

const DATE_CELL = /^(\d{4}-\d{2}-\d{2}|unrecorded)$/;

/** A heading that introduces the blank form a decision is written into, not decisions. */
const TEMPLATE_HEADING = /Template/i;

/** A decision record together with the columns that give its cells their meaning. */
export type DecisionRecord = {
  row: DecisionRow;
  columns: string[];
  /** False when the log wrote this record after another one on the SAME line, instead of below it. */
  opensLine: boolean;
};

/**
 * Every decision the log records, whether it sits in a table or in a fragment.
 *
 * This is the census's declared subject for the decision log, and it is one call so that no
 * assertion can accidentally cover only the part of the log that still renders as a table.
 *
 * Three classifications are made here, and each is by a DECLARED property rather than a spelling.
 *
 * The template table is excluded because it is a form, not a record of anything: its one row is a
 * placeholder for text a future decision will supply. Its heading says so. No other table is
 * excluded, and in particular an id is not tested against a pattern — two rows of the seeded table
 * carry a NOTE- id rather than a DEC- one (`NOTE-6.5-DESIGN-CLOSE`, `NOTE-RTK-FILTER-RISK`), and a
 * pattern test would drop them from every assertion below without saying that it had. An id that is
 * absent, however, leaves nothing to identify the record by, so a row without one is not a record.
 *
 * An orphaned row is given the columns of the table it was cut from, since a blank line removes the
 * row's place in the table but not the meaning of its cells.
 *
 * A record glued onto the end of another is reported as a record of its own. `||` where a line
 * break belongs writes one line holding two records: the first record's cells, an empty cell from
 * the doubled pipe, then the second record's cells. Reading only the first cell makes the second
 * record invisible — and worse, makes any reference to it look like a reference to an id with no
 * record at all. Both records are real and both are checked.
 */
export function decisionRecords(text: string, file: string): DecisionRecord[] {
  const tables = censusDecisionLogFromText(text, file);
  const records: DecisionRecord[] = [];

  for (const table of tables) {
    if (TEMPLATE_HEADING.test(table.heading)) continue;
    for (const row of table.rows) {
      if (row.id === "") continue;
      records.push({ row, columns: table.columns, opensLine: true });
      records.push(...recordsGluedTo(row, table.columns));
    }
  }
  for (const row of orphanedDecisionRows(text, file)) {
    const source = tables.filter((table) => table.line < row.line).pop();
    const columns = source?.columns ?? [];
    records.push({ row, columns, opensLine: true });
    records.push(...recordsGluedTo(row, columns));
  }
  return records;
}

/**
 * The records the log glued onto a row's own line.
 *
 * A doubled pipe produces an empty cell, so a record that opens at cell `k * (columns + 1)` with an
 * empty cell immediately before it sits exactly where a second record would land.
 */
function recordsGluedTo(row: DecisionRow, columns: string[]): DecisionRecord[] {
  if (columns.length === 0) return [];
  const stride = columns.length + 1;
  const glued: DecisionRecord[] = [];

  for (let opening = stride; opening < row.cells.length; opening += stride) {
    const head = row.cells[opening];
    if (head === undefined || head === "" || row.cells[opening - 1] !== "") continue;
    glued.push({
      row: { ...row, id: head, cells: row.cells.slice(opening) },
      columns,
      opensLine: false,
    });
  }
  return glued;
}

/** The date a decision record states, when its columns declare a Date column. */
export function dateCellOf(record: DecisionRecord): string | null {
  const column = record.columns.indexOf("Date");
  if (column === -1) return null;
  return record.row.cells[column] ?? null;
}

const BARE_DECISION_ID = /^DEC-\d{4}$/;

/**
 * The id a Supersedes cell declares, or null when the cell declares none.
 *
 * The column is written as prose. Measured over the file's 204 Supersedes cells: 62 read `N/A`, 84
 * are prose naming no id, 57 are prose naming one or more ids in a sentence — "Extends DEC-0108's
 * Trusted Recruiter model", "Paired with DEC-0132", "Closes 6.5-DESIGN under DEC-0104" — and exactly
 * ONE holds nothing but an id. Reading every id out of a sentence invents supersede claims the
 * sentence does not make: an any-id reading of this column reports eight direction defects, and one
 * of those eight is real.
 *
 * So the claim is read where it is unambiguous, and nowhere else. A cell holding only an id states
 * that the row supersedes that id, and that is checkable. A prose cell states no single classifiable
 * fact, so the census reports nothing about it rather than guessing — which leaves the column's
 * prose unpolished by this instrument, and that coverage limit is stated rather than hidden.
 */
export function supersedeClaimOf(record: DecisionRecord): string | null {
  const column = record.columns.indexOf("Supersedes");
  if (column === -1) return null;
  const cell = (record.row.cells[column] ?? "").trim();
  return BARE_DECISION_ID.test(cell) ? cell : null;
}

/**
 * The Supersedes cells this census reads a claim from — the bare-id cells, and no others.
 *
 * This is the COVERAGE of the three obligations that assert over supersede claims, measured so it
 * can be stated rather than assumed: 1 cell of the log's 204. Raising the reading to the prose
 * cells is parser work over a column whose direction is itself unruled, so it is not done here.
 * Losing one of the cells a claim IS read from is the other direction, and it is asserted as a
 * floor — a claim that stops being examined should fail a close rather than quietly stop counting.
 */
export function supersedeClaimCells(records: DecisionRecord[]): DecisionRecord[] {
  return records.filter((record) => supersedeClaimOf(record) !== null);
}

/**
 * Records whose Date cell does not hold a date. A cell holding the row's own status instead is the
 * shape a copy-paste out of the Status column leaves behind.
 */
export function rowsWithNonDate(records: DecisionRecord[]): DecisionRow[] {
  return records
    .filter((record) => {
      const value = dateCellOf(record);
      return value !== null && !DATE_CELL.test(value);
    })
    .map((record) => record.row);
}

/** A pipe-delimited line that opens with an identifier cell, so it is a record and not a rule. */
const ORPHAN_ROW_LINE = /^\|\s*[A-Za-z0-9][^|]*\|/;

/**
 * Decision rows that sit in no table at all.
 *
 * Markdown ends a table at the first blank line. A table interrupted that way renders only up to
 * the interruption; every row after it stops being a row and becomes a pipe-delimited paragraph.
 * The rows are still on disk and still grep, which is what makes this quiet — a reader counting
 * pipe-delimited lines sees the whole set, while the rendered page shows a fraction of it. So the
 * census reports them as data rather than letting the table reader stop and say nothing.
 */
export function orphanedDecisionRows(text: string, file: string): DecisionRow[] {
  const lines = text.split("\n");
  const insideTable = new Set<number>();
  for (const table of censusDecisionLogFromText(text, file)) {
    insideTable.add(table.line);
    insideTable.add(table.line + 1);
    for (const row of table.rows) insideTable.add(row.line);
  }

  const orphans: DecisionRow[] = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (insideTable.has(line) || !ORPHAN_ROW_LINE.test(raw)) return;
    const cells = splitRow(raw);
    orphans.push({ file, line, id: cells[0] ?? "", cells });
  });
  return orphans;
}

export type SupersedesFinding = {
  row: DecisionRow;
  referenced: string;
  kind: "names-newer" | "names-itself" | "names-no-row";
};

/**
 * Every declared supersede claim that does not read as a row naming something it supersedes, by kind.
 *
 * The three kinds are reported together and ASSERTED separately, because they are not the same
 * claim. Naming the row's own id, and naming an id the log has no record for, are wrong on their
 * own terms. Naming a NEWER id is the direction question: a row names what IT supersedes, so a
 * claimed id is lower than the row's own — the direction the column's prose follows throughout
 * ("Supersedes the archive clauses of DEC-0019/0020", "Extends DEC-0108's model") — and a claim on a
 * newer id has that reversed: it records being superseded on the superseded row, which is the other
 * row's business and is already written there. Whether the column is allowed to run that way is a
 * ruling no one has made, so the caller files it rather than pinning a number to it.
 *
 * All three are read from the bare-id cells only, which is the limit stated in `supersedeClaimOf`.
 */
export function supersedesFindings(records: DecisionRecord[]): SupersedesFinding[] {
  const known = new Set(records.map((record) => record.row.id));
  const findings: SupersedesFinding[] = [];

  for (const record of records) {
    const claimed = supersedeClaimOf(record);
    if (claimed === null) continue;
    const kind =
      claimed === record.row.id
        ? "names-itself"
        : !known.has(claimed)
          ? "names-no-row"
          : decisionNumber(claimed) > decisionNumber(record.row.id)
            ? "names-newer"
            : null;
    if (kind !== null) findings.push({ row: record.row, referenced: claimed, kind });
  }
  return findings;
}

function decisionNumber(id: string): number {
  return Number.parseInt(id.replace(/\D/g, ""), 10);
}

/** How many claims of one kind the log declares, for an obligation that pins one kind. */
export function supersedesOfKind(
  records: DecisionRecord[],
  kind: SupersedesFinding["kind"],
): number {
  return supersedesFindings(records).filter((finding) => finding.kind === kind).length;
}

/** Records the log wrote on the same line as the record before them, rather than below it. */
export function gluedRecords(records: DecisionRecord[]): DecisionRecord[] {
  return records.filter((record) => !record.opensLine);
}

/**
 * Records whose cell count is not the count their own columns declare. Markdown drops the extras, so
 * the cell that a stray pipe landed in stops at the pipe and the rest of its text never renders.
 *
 * A line holding two glued records is left out here and reported by `gluedRecords` instead: its
 * extra cells are not a stray pipe, and the repair is a different one.
 */
export function rowsOffColumnCount(records: DecisionRecord[]): DecisionRecord[] {
  const gluedLines = new Set(gluedRecords(records).map((record) => record.row.line));
  return records.filter((record) => {
    if (!record.opensLine || record.columns.length === 0) return false;
    if (gluedLines.has(record.row.line)) return false;
    return record.row.cells.length !== record.columns.length;
  });
}

// ---------------------------------------------------------------------------------------------
// The ratchets
// ---------------------------------------------------------------------------------------------

/** How a bound is held: at the number exactly, or at or above it. */
export type RegisterBound = "exact" | "floor";

export type RegisterObligation = {
  what: string;
  /** The command that produced the number, so the next reader can re-measure rather than trust it. */
  measuredBy: string;
  reason: string;
} & (
  | {
      /**
       * The number this obligation is held at.
       *
       * `exact` fails on any movement in either direction. `floor` fails only BELOW the number.
       */
      bound: number;
      direction: RegisterBound;
    }
  | {
      /**
       * The register reports this number without asserting it.
       *
       * Null is not headroom and not a number nobody got round to pinning. It records that no ruling
       * says which value is right, so a close that failed on it would force whoever is closing to
       * invent that ruling by editing a number until the gate went green. The measurement still runs
       * and still prints either way — what null removes is the assertion, not the instrument. Filing
       * the item is what turns one of these into a bound. There is no direction to hold, so there is
       * none to record.
       */
      bound: null;
      direction: null;
    }
);

/**
 * ONE spelling, shared by the obligation table and the dispatcher.
 *
 * The dispatcher is keyed on the `what` string, so a second spelling would not fail to compile: the
 * table would assert a number and the dispatcher would throw for an unwired obligation. Naming it
 * once is what makes the two agree by construction rather than by a reader comparing them.
 */
const NON_REGISTER_ID_BULLETS = "register bullets whose head id is not a register id";

/**
 * The ratchets.
 *
 * WHAT THESE DO AND DO NOT ENFORCE, stated plainly. A bound cannot make an anchorless item
 * impossible: the number is editable like any other. What it does is put the count on one line that
 * a reviewer reads in the diff, so that ADDING an anchorless live item is a deliberate edit to a
 * stated number, and ANCHORING one forces that number down in the same commit.
 *
 * TWO KINDS, and the difference is which direction the register moves as it improves:
 *
 *  - `exact` for a count of DEFECTS, where every instance is meant to be driven to zero and a fall
 *    is a repair that must move the literal with it rather than leave headroom.
 *  - `floor` for a count of something the register is trying to do MORE of — a canonicalised anchor
 *    raises the anchored population, so pinning it exactly would fail a close for making things
 *    better. A floor still fails on a FALL, which is the direction that loses coverage silently.
 *
 * These are LITERALS, not sums over the census. Deriving a bound from the thing it bounds makes the
 * assertion true by construction and measures nothing.
 */
export const REGISTER_OBLIGATIONS: readonly RegisterObligation[] = Object.freeze([
  {
    // The unit is IDS and the string says so. An item filed twice contributes two entries to one
    // id, so a literal reading "50" is 50 of two different things depending on which the reader
    // assumed, and the pair (50 ids / 53 entries) is reported together for that reason.
    what: "distinct live debt ids carrying no anchor at all",
    bound: 47,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "LOWERED FROM 48 TO 47 ON 2026-09-19, BY DISCHARGE, the same direction as the 50→48 move " +
      "below: LAUNCH-D62 (anchorless since filing) was marked `· DISCHARGED` on its anchor line " +
      "once Rule 23's text was amended to match DEC-0215, so it left the live population and left " +
      "this count with it. Read off the gate's own `lower the literal to 47` rather than computed. " +
      "mostly the Step 7.1 and 6.5.INFRA sections, filed before anchoring was practised, plus the " +
      "items the Block C Phase 1 depth review filed without one. Anchoring an item lowers this and " +
      "nothing raises it except a deliberate edit to this literal; an item filed without an anchor " +
      "in a live section fails the close that files it, so the population should now only shrink. " +
      "Lowered from 50 to 48 on 2026-09-16, and the reason matters more than the number: it fell by " +
      "DISCHARGE, not by drift. A discharged item leaves the live population, so it leaves this " +
      "one, and that is a second way down that the paragraph above did not name — it described " +
      "anchoring as the only repair. What happened is that LAUNCH-D59 and LAUNCH-D61 each carry a " +
      "discharged reporting entry AND an unmarked original, and until this close only the reporting " +
      "entry was marked, so the originals were still counted here while the register read as though " +
      "they were closed. Marking the originals moved this literal, which is the opposite direction " +
      "from the drift a floor guards against: a fall by discharge is a measured population leaving, " +
      "not coverage being lost. Read off the gate's own `lower the literal to 48` rather than " +
      "computed, and the two ids are individually checkable at :4339 and :4387. The partition is " +
      "now 48 anchorless plus 65 canonical plus 17 partial = the 130 the header prints. THIS LINE " +
      "WAS MOVED BY THE CLOSE THAT WROTE IT, for the FIFTH time and for the reason LAUNCH-D119 " +
      "files: LAUNCH-D124 through LAUNCH-D126 were filed in this same change and each carries " +
      "`→ Step 7.7 Block D`, so the canonical term gained three between this sentence being " +
      "written and this sentence being read. The demonstration arrived before this line was " +
      "committed, again — as it did the FOURTH time, when LAUNCH-D120 through LAUNCH-D123 were " +
      "filed in their own change and moved the canonical term by four under the same sentence. " +
      "LAUNCH-D119 " +
      "was filed after this sentence was corrected and moved the canonical term by one, which is " +
      "this obligation's own item demonstrated on its own correction: the class it files is that a " +
      "reason string cannot be kept true by hand, because the close that files an item is the close " +
      "that invalidates the partition sentence it just wrote. THIS " +
      "SENTENCE WAS TWO CLOSES STALE AND IS CORRECTED AT BLOCK C2'S STAGE 1 (2026-09-16), which is " +
      "the follow-through on the close that read the other literal off the gate's output and left " +
      "this one under a one-obligation scope. It said `48 plus 51 plus 19 = 118` while the header " +
      "had already printed 123, so a reader meeting the partition here was being handed a sum that " +
      "had not been true since two closes earlier — the failure this whole reason string exists to " +
      "prevent, committed inside the instrument that prevents it. The partition moved in TWO " +
      "DIRECTIONS at this close for the first time: 48 anchorless plus 56 canonical plus 19 " +
      "partial = 123 before, 122 after. LAUNCH-D118 was filed carrying `→ Step 7.7 Block D`, which " +
      "is the canonical term's one gain; BETA-D17 and BETA-D28 were marked `· DISCHARGED " +
      "2026-09-16, PARTIAL` on their anchor lines, which took both out of the live population and " +
      "is the partial term's loss of two. The anchorless term did not move, and a reader checking " +
      "this sentence against the header sees 122 and can decompose it the same way",
  },
  {
    what: "live debt ids carrying an anchor that names a step and a block",
    bound: 127,
    direction: "floor",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "THE ONE POPULATION THAT RISES AS THE REGISTER IMPROVES, so it is held as a floor rather " +
      "than a pin. WHAT IT CATCHES IS THE DIRECTION NOTHING ELSE DOES: rewriting an existing " +
      "anchor to `→ TBD` leaves every other instrument at baseline — gate (a) compares id " +
      "sets and an edit is not a filing, gate (b) reads bare block anchors only, and the " +
      "anchorless ratchet accepts any non-null anchor, junk included. So the floor follows the " +
      "population up, or it leaves that many anchors of slack in the one instrument watching for " +
      "an anchor degrading out of canonical form. THIS NUMBER DOES NOT PARTITION THE LIVE " +
      "POPULATION ON ITS OWN, and that is a property of the register rather than a gap here: ids " +
      "anchored `→ Step 7.7.` carry a step and no block, which no predicate classifies, so the " +
      "live total decomposes into this count plus the anchorless ratchet plus that unclassified " +
      "remainder. A WITHDRAWN ENTRY COUNTS HERE exactly as a discharged one does, because it " +
      "keeps its anchor line — which is why the literal is READ OFF THE GATE'S OWN " +
      "`raise the bound to N` and never computed from a close's filings, and why a raise is not " +
      "trusted until the floor has been PROVEN RED one below it, by the probe wherever the probe " +
      "can reach a verdict. THE DATED RECORD OF EVERY MOVE THIS BOUND HAS TAKEN IS DELIBERATELY " +
      "NOT HERE. It is in `docs/project/register-bound-history.md`, verbatim, and the separation " +
      "IS LAUNCH-D119's repair applied to the string that item was filed against: a dated claim " +
      "about a past close may carry whatever it carried then, a present-tense claim about the " +
      "current state must be read from the measurement or be asserted, and the two stop being " +
      "distinguishable once they are interleaved in one paragraph. That string had reached 2,899 " +
      "words and eighteen dated entries, and nothing reads it — `reason` is never printed by the " +
      "gate and never asserted by a test, so every live-state literal in it was a claim with no " +
      "instrument behind it. What remains states what this obligation MEANS and carries no " +
      "live-state number at all; the `bound` above is the only literal, and it is the one a " +
      "machine checks",
  },
  {
    what: "items a discharged section declares discharged whose anchor line carries no mark",
    bound: 0,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "LOWERED FROM TWO TO ZERO AT BLOCK C2'S STAGE 1 (2026-09-16), ON THE OWNER'S RULING, and the " +
      "pin it replaces is worth keeping because the argument it made has not been answered — it " +
      "has been overruled. It was pinned at two for three closes: BETA-D17 and BETA-D28 each had " +
      "an entry under a discharge section AND an anchor line under `### Open` carrying no mark, so " +
      "the register contradicted itself about both, filing the same id as discharged in one place " +
      "and as live in another. The pin's own reason argued against marking them — both anchor " +
      "lines carried deferred work, BETA-D17's DOMAIN MOVE and BETA-D28's remaining surfacing, and " +
      "marking either would delete that work from the live population, which is the defect the " +
      "mark exists to make visible — and recommended a ruling on which of the two entries was " +
      "wrong rather than a transcription. **The ruling is that both are discharged.** Both anchor " +
      "lines now carry `· DISCHARGED 2026-09-16, PARTIAL`, and the PARTIAL qualifier is where the " +
      "surviving work is named. **That qualifier is load-bearing and nothing in this census " +
      "enforces it**: with the marks in place neither id is live, so the deferred remainder is " +
      "recorded by its `### Discharged` entry and by nothing else — no population here counts a " +
      "discharge-section entry, so a close that swept one would be sweeping the only record of " +
      "that work without failing anything. Measured value 0, read off this gate's own " +
      "`lower the literal to 0` rather than computed by subtracting two from the pin" +
      ". THE PROBE WAS REPAIRED IN THE SAME CHANGE, and that repair is the evidence this " +
      "obligation is still live at a bound of zero. Its detector had pinned the measured VALUE — " +
      "`FAIL\\s+3` — which was the pin plus one, so the mutation stopped producing the asserted " +
      "string the moment the register moved and the probe reported no verdict at all. It now reads " +
      "`FAIL\\s+\\d+\\s+items a discharged section declares discharged whose anchor line carries " +
      "no mark\\s+\\(up 1\\)`: the obligation named, the direction, and that the mutation moved it " +
      "by exactly one, with the count left to the register. `npm run verify:register-probe` strips " +
      "BETA-D29's mark, the gate failed `1  items a discharged section declares discharged whose " +
      "anchor line carries no mark  (up 1)`, the harness restored the register with " +
      "`RESTORE OK (1 file(s) match HEAD)`, and the suite reported `15/15 probes went red as " +
      "claimed.`",
  },
  {
    what: NON_REGISTER_ID_BULLETS,
    bound: 29,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "THE CENSUS'S FAIL-OPEN, MADE MEASURED. A bullet headed `- **C1**`, `- **M1 / M3**`, " +
      "`- **TRAP-1: …` or `- **INCIDENT-2026-07-16 …` is read by the head matcher and then dropped " +
      "because the token is not a `<name>-D<n>` or `<name>-T<n>` id, so a mistyped id vanishes from " +
      "every population without saying so and this count is the only place it appears. Refusing is " +
      "not available: these 25 are in the register as it stands, so a census that refused them " +
      "could not be green on the file it is written over. A 26th fails a close and names itself. " +
      "WHAT THE 25 CONSIST OF, measured rather than assumed: 18 are id-shaped labels from series " +
      "the register does not own (C1, M1 / M3, S5, T1, SCH2, SCH4, TRAP-1, TRAP-2, INFER-1, " +
      "INFER-2, INCIDENT-2026-07-16, DEPLOY-DEBT-1, 6.5e-Sec-I1, 6.5f.1-S2, DOC-RESID-4, " +
      "DOC-RESID-6, DOC-RESID-7 and the like), which is the population this count was written for. " +
      "THE OTHER 7 ARE NOT LABELS AT ALL — they are prose sentences counted for opening with a " +
      "bare word: `Fresh debt-id census …`, `Rule 31 — deploy environment gate …`, " +
      "`Guarded-surface tripwire …`, three opening `The …`, and `Vercel Deployment Protection does " +
      "not answer 401.` They sit in narrative subsections the way the `Learnings` bullets did, and " +
      "they survive only because `Learnings` is the one narrative kind excluded by section " +
      "structure. That is the same accident this exclusion removed, not a different one, and it is " +
      "named here rather than fixed because which narrative subsections the register recognises is " +
      "a convention question. Which of the remaining 18 are legitimate foreign labels and which " +
      "are ids typed wrong is the older question, filed separately in open-debt.md — this literal " +
      "holds the count until those rulings land, and moves with them when they do",
  },
  {
    what: "decision-log rows whose cells do not match their columns' declared count",
    bound: 0,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "each row wrote an unescaped pipe inside a cell — a SQL `||` concatenation, an enum " +
      "alternation — so markdown ended the cell there and every character after it never rendered. " +
      "All six were repaired in the Block C Phase 3 close by escaping the pipe (`|` to `\\|`), " +
      "which changes no character of the prose. This is a TRUE ZERO rather than a stock: a row whose " +
      "cell count is not its columns' count is now a defect with no accepted instance, so a close " +
      "that produces one fails",
  },
  {
    what: "decision-log rows a blank line left outside every table",
    bound: 106,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "one blank line at :373 ends the seeded-decisions table, so DEC-0115 onward stop rendering as " +
      "rows and become pipe-delimited paragraphs. They still grep, which is what makes this quiet; " +
      "the number counts rows, not the one cause, so removing the blank line takes it to zero. " +
      "Raised from 96 to 100 on 2026-09-16 by the one cause moving four rows further down, NOT by " +
      "four new orphans: this close appended four seeded rows below the break and the blank line " +
      "shifted from :369 to :373 for the unrelated reason that the same close appended four rows to " +
      "the Index above it. Every one of the hundred is still accounted for by that single blank line, " +
      "and the check the number does perform is unchanged — it is an exact bound, so it fails if " +
      "anything ADDS an orphan somewhere else in the log. Read off the gate's own `(up 4)` rather " +
      "than computed. The repair remains the one-line deletion the paragraph above names, and it is " +
      "owed: a hundred of this log's two hundred and five seeded rows — DEC-0115 through DEC-0215, " +
      "every decision taken since 2026-07-27 — do not render as a table today, and the seeded table " +
      "is the half of the log that carries the rationales. Raised 100 → 103 at Step 7.7 Block C2 " +
      "Phase 1's close: DEC-0216 to DEC-0218 were appended below the blank line that already orphans " +
      "DEC-0115 onward. The repair is TRUST-D15, and it resets this bound in the same pass",
  },
  {
    what: "decision-log rows written on another record's line instead of below it",
    bound: 1,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "DEC-0123 sits after DEC-0122 on the same line, separated by `||` where a line break belongs. " +
      "The record's cells are intact and it is read; what the line costs is its own line number",
  },
  {
    what: "decision-log rows whose Date cell does not hold a date",
    bound: 1,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "DEC-0095's Date cell holds `accepted`, copied out of the Status column. The row records no " +
      "date and the Index column that exists to carry one is empty",
  },
  {
    // Split out of one "supersede claims that cannot be true" obligation, because the three kinds
    // are not the same claim. Naming your own row, and naming a row the log does not have, are
    // wrong on their own terms and are asserted at zero. Naming a NEWER row is a question about
    // which direction the column runs, no ruling has answered it, and it is filed instead.
    what: "decision-log supersede claims naming their own row",
    bound: 0,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "a row that supersedes itself states a relation it cannot stand in. COVERAGE LIMIT, stated " +
      "rather than hidden: the claim reading below examines only the cells that hold nothing but an " +
      "id — one of the log's 204 Supersedes cells — so this asserts at zero over a population of " +
      "one. A cell naming its own row inside prose is not classified as a claim and does not reach " +
      "this obligation; that reading is where a self-reference is actually found, and it is filed " +
      "as the direction item rather than asserted here",
  },
  {
    what: "decision-log supersede claims naming an id the log has no row for",
    bound: 0,
    direction: "exact",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "the claim cannot be checked against the row it names, because there is no row to check it " +
      "against — the id is either a typo or a decision that was never written down. Same coverage " +
      "limit as the obligation above: the claim is read from a bare-id cell only, so a prose cell " +
      "naming an absent id is unclassified rather than passing",
  },
  {
    what: "decision-log Supersedes cells holding nothing but an id",
    bound: 2,
    direction: "floor",
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "THE COVERAGE OF THE THREE OBLIGATIONS ABOVE, pinned so it cannot shrink unremarked: they " +
      "examine 2 cells of the column's 205, so losing those cells would take them from asserting " +
      "over " +
      "a population of two to asserting over nothing, which is a green instrument watching an empty " +
      "set. Raised from 1 to 2 on 2026-09-16 by the close that appended DEC-0213, whose Supersedes " +
      "cell holds the bare id `DEC-0201` — a DECIDED supersession rather than a prose one, and the " +
      "first row in the log to name a lower id in this column than its own, so it raises no " +
      "direction finding. Read off the gate's own `raise the bound to 2` rather than computed. " +
      "Extending the reading to the 203 prose cells is parser work over a column whose " +
      "direction is itself unruled — building coverage before the direction is decided would make " +
      "an instrument that enforces an ambiguity — so that happens when the direction ruling lands, " +
      "and this floor is what holds the ground in the meantime",
  },
  {
    what: "decision-log supersede claims naming a newer decision than their own row",
    bound: null,
    direction: null,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "REPORTED, NOT ASSERTED, and the distinction is the whole finding. The claim reading finds " +
      "exactly one row — DEC-0010's Supersedes cell holds `DEC-0153`, a newer id, while that row's " +
      "own Status reads `superseded in part`. That is the column running as `superseded by` on this " +
      "row and as `supersedes` on the others, and which direction it is meant to carry is a ruling " +
      "nobody has made. A bound here would make the next close invent that ruling by lowering a " +
      "number. Read over every cell rather than the bare-id ones, the same question returns EIGHT " +
      "rows naming a newer id — five of them merely mentioning one (`Retention is DEC-0122`, " +
      "`Paired with DEC-0132`) — which is a different population and is why neither number is " +
      "pinned. Filed as its own item in open-debt.md, LOW, → Step 7.7 Block C",
  },
]);

/**
 * The register as the doc repository last committed it. Gate (a)'s baseline.
 *
 * A close writes the controller's block into the working tree, so the revision it started from is
 * the one HEAD holds. Reading the baseline from git rather than from a pinned list is what lets
 * gate (a) have a population with no literal to maintain — and a git that cannot answer REFUSES.
 * Both failure directions are real: an empty baseline makes every item in the file look newly
 * filed, and a silently absent one makes the gate vacuous while it reports success.
 *
 * The revision comes back with the text so the report can name the revision it compared against
 * rather than asserting that a comparison happened.
 */
export function committedRegister(
  repoDir: string,
  path: string,
): { revision: string; text: string } {
  try {
    return {
      revision: execFileSync("git", ["-C", repoDir, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      text: execFileSync("git", ["-C", repoDir, "show", `HEAD:${path}`], { encoding: "utf8" }),
    };
  } catch {
    throw new RegisterRefusal(path, 0, `the committed revision could not be read from ${repoDir}`);
  }
}

export type RegisterMeasurement = {
  obligation: RegisterObligation;
  measured: number;
  /**
   * The members behind `measured`, where the count means nothing without them.
   *
   * Empty for every obligation whose subject is fully stated by its number. The skip population is
   * the one that is not: "32" says nothing about WHICH bullets the census is leaving out, and the
   * question the number exists to raise — which of these are labels and which are mistyped ids —
   * cannot be asked without the list. So the subject travels as data (Rule 38) rather than as an
   * artefact of whichever caller happened to print it.
   */
  members: readonly string[];
};

/**
 * Every obligation with the number its own detector produces.
 *
 * ONE DISPATCHER, so the bound can never be asserted against a detector that only one of the two
 * callers runs. The test suite asserts these numbers exactly; the CLI prints them and refuses a
 * close that moves one the wrong way. An obligation with no detector THROWS rather than reporting
 * zero — a ratchet that measures nothing passes forever, which is the failure mode this whole
 * module exists to avoid.
 */
export function measureRegister(
  registerFile: string,
  decisionLogFile: string,
): RegisterMeasurement[] {
  const items = censusDebtItems(registerFile);
  const log = readDecisionLog(decisionLogFile);
  const records = decisionRecords(log, decisionLogFile);

  /** A measurement whose number is its whole subject. */
  const count = (measured: number): Omit<RegisterMeasurement, "obligation"> => ({
    measured,
    members: [],
  });

  const detect = (what: string): Omit<RegisterMeasurement, "obligation"> => {
    switch (what) {
      case "distinct live debt ids carrying no anchor at all":
        return count(anchorlessLiveIds(items).length);
      case "live debt ids carrying an anchor that names a step and a block":
        return count(canonicalAnchoredLiveIds(items).length);
      case "items a discharged section declares discharged whose anchor line carries no mark":
        return count(dischargedWithoutMark(items).length);
      case NON_REGISTER_ID_BULLETS: {
        const skipped = censusSkippedBullets(registerFile);
        return {
          measured: skipped.length,
          members: skipped.map((bullet) => `${bullet.id}:${bullet.line}`),
        };
      }
      case "decision-log rows whose cells do not match their columns' declared count":
        return count(rowsOffColumnCount(records).length);
      case "decision-log rows a blank line left outside every table":
        return count(orphanedDecisionRows(log, decisionLogFile).length);
      case "decision-log rows written on another record's line instead of below it":
        return count(gluedRecords(records).length);
      case "decision-log rows whose Date cell does not hold a date":
        return count(rowsWithNonDate(records).length);
      case "decision-log supersede claims naming their own row":
        return count(supersedesOfKind(records, "names-itself"));
      case "decision-log supersede claims naming an id the log has no row for":
        return count(supersedesOfKind(records, "names-no-row"));
      case "decision-log Supersedes cells holding nothing but an id":
        return count(supersedeClaimCells(records).length);
      case "decision-log supersede claims naming a newer decision than their own row":
        return count(supersedesOfKind(records, "names-newer"));
      default:
        throw new Error(`no measurement is wired for the obligation ${JSON.stringify(what)}`);
    }
  };

  return REGISTER_OBLIGATIONS.map((obligation) => ({
    obligation,
    ...detect(obligation.what),
  }));
}

/** Reads the decision log, refusing rather than reporting an empty one. */
export function readDecisionLog(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new RegisterRefusal(file, 0, "the decision log could not be read");
  }
}

/**
 * The census in one line, counting IDS rather than entries.
 *
 * An item may be filed twice — a body entry and a disposition entry — and the question every
 * assertion asks is about the ITEM, not about how many times the register mentions it. Counting
 * entries would make anchoring an item that happens to be filed twice move the number by one while
 * the population moved by zero. Entry counts are reported alongside so the difference is visible.
 */
export function summariseRegister(items: DebtItem[]): {
  items: number;
  live: number;
  liveEntries: number;
  anchorlessLive: number;
  anchorlessLiveEntries: number;
  canonicalAnchoredLive: number;
  bareAnchoredLive: number;
} {
  const live = items.filter((item) => item.live);
  return {
    items: items.length,
    live: liveIds(items).length,
    liveEntries: live.length,
    anchorlessLive: anchorlessLiveIds(items).length,
    anchorlessLiveEntries: live.filter((item) => item.anchor === null).length,
    canonicalAnchoredLive: canonicalAnchoredLiveIds(items).length,
    bareAnchoredLive: bareAnchoredLiveIds(items).length,
  };
}
