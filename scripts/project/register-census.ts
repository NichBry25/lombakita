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
  /** The item sits under a live disposition section and its own line states no closure. */
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
 * Reads every debt item in the register at `file`.
 *
 * Throws `RegisterRefusal` for a line it cannot classify. A missing file is refused too: this
 * census has no meaningful result over an absent register, and reporting an empty population would
 * read as "no debt".
 */
export function censusDebtItems(file: string): DebtItem[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RegisterRefusal(file, 0, "the register could not be read");
  }
  return censusDebtItemsFromText(text, file);
}

/** The same census over text already in hand, for a caller comparing two revisions of one file. */
export function censusDebtItemsFromText(text: string, file: string): DebtItem[] {
  const lines = text.split("\n");
  const items: DebtItem[] = [];
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
    if (matched === undefined || id === undefined || !REGISTER_ID.test(id)) continue;

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
    const anchor = anchored ? declared.slice(arrow, arrow + 80).replace(/\*\*/g, "").trim() : null;

    items.push({
      file,
      line,
      id,
      severity: severity ?? "",
      block,
      section,
      anchor,
      anchorIsBareBlock: anchor !== null && BARE_BLOCK_ANCHOR.test(anchor),
      anchorNamesStep: anchor !== null && NAMES_STEP.test(anchor),
      discharged: declaredDischarged,
      live: LIVE_SECTION.test(section) && !declaredDischarged,
    });
  }

  return items;
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
 * The live items filed by `after` that `before` did not hold, and that carry no anchor naming a
 * step. Gate (a)'s population: this is the bleeding, not the wound.
 *
 * Identity is the id, so an item that merely moved lines is not newly filed, and an item whose id
 * already existed is not re-judged here — pre-existing debt is the ratchet's business.
 */
export function newlyFiledWithoutStepAnchor(before: DebtItem[], after: DebtItem[]): DebtItem[] {
  const known = new Set(before.map((item) => item.id));
  const namesStep = new Set(after.filter((item) => item.anchorNamesStep).map((item) => item.id));
  return after.filter(
    (item) => item.live && !known.has(item.id) && !namesStep.has(item.id),
  );
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
 * The column is written as prose. Measured over the file: 62 cells read `N/A`, 85 are prose naming
 * no id, 53 are prose naming one or more ids in a sentence — "Extends DEC-0108's Trusted Recruiter
 * model", "Paired with DEC-0132", "Closes 6.5-DESIGN under DEC-0104" — and exactly ONE holds
 * nothing but an id. Reading every id out of a sentence invents supersede claims the sentence does
 * not make: an any-id reading of this column reports eight direction defects, and one of those eight
 * is real.
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
 * Declared supersede claims that cannot be true.
 *
 * A row names what IT supersedes, so a claimed id is lower than the row's own — the direction the
 * column's prose follows throughout ("Supersedes the archive clauses of DEC-0019/0020",
 * "Extends DEC-0108's model"). A claim on a newer id has the direction reversed: it records being
 * superseded on the superseded row, which is the other row's business and is already written there.
 * A claim on the row's own id, and a claim on an id with no record, are wrong on their own terms.
 */
export function supersedesFindings(records: DecisionRecord[]): SupersedesFinding[] {
  const known = new Set(records.map((record) => record.row.id));
  const findings: SupersedesFinding[] = [];

  for (const record of records) {
    const claimed = supersedeClaimOf(record);
    if (claimed === null) continue;
    const kind = claimed === record.row.id ? "names-itself"
      : !known.has(claimed) ? "names-no-row"
      : decisionNumber(claimed) > decisionNumber(record.row.id) ? "names-newer"
      : null;
    if (kind !== null) findings.push({ row: record.row, referenced: claimed, kind });
  }
  return findings;
}

function decisionNumber(id: string): number {
  return Number.parseInt(id.replace(/\D/g, ""), 10);
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

export type RegisterObligation = {
  what: string;
  /** The most the register may hold. May go DOWN and never up. */
  ceiling: number;
  /** The command that produced the number, so the next reader can re-measure rather than trust it. */
  measuredBy: string;
  reason: string;
};

/**
 * The ratchets.
 *
 * WHAT THESE DO AND DO NOT ENFORCE, stated plainly. A ceiling cannot make an anchorless item
 * impossible: the number is editable like any other. What it does is put the count on one line that
 * a reviewer reads in the diff, so that ADDING an anchorless live item is a deliberate edit to a
 * stated number, and ANCHORING one forces that number down in the same commit.
 *
 * These are LITERALS, not sums over the census. Deriving a bound from the thing it bounds makes the
 * assertion true by construction and measures nothing.
 */
export const REGISTER_OBLIGATIONS: readonly RegisterObligation[] = Object.freeze([
  {
    what: "distinct live debt items carrying no anchor at all",
    ceiling: 50,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "mostly the Step 7.1 and 6.5.INFRA sections, filed before anchoring was practised, plus the " +
      "items the Block C Phase 1 depth review filed without one. Anchoring an item lowers this and " +
      "nothing raises it except a deliberate edit to this literal; an item filed without an anchor " +
      "in a live section fails the close that files it, so the population should now only shrink",
  },
  {
    what: "items a discharged section declares discharged whose anchor line carries no mark",
    ceiling: 2,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "PINNED AT TWO, NOT AT ZERO, and the two are a finding rather than a tolerance. BETA-D17 and " +
      "BETA-D28 each have an entry under a discharge section AND an anchor line under `### Open` " +
      "carrying no mark, so the register contradicts itself about both: the same id is filed as " +
      "discharged in one place and as live in another. Both severities read PARTIAL — BETA-D17's " +
      "DOMAIN MOVE is deferred to Block D, BETA-D28 is `[PARTIAL → minimum surfacing landed]` — so " +
      "marking either anchor line DISCHARGED would delete live deferred work from the live " +
      "population, which is the defect the mark exists to make visible. The repair is a ruling on " +
      "which of the two entries is wrong, not a transcription. Three of the five items this was " +
      "expected to clear were unambiguous and are marked; these two were not",
  },
  {
    what: "decision-log rows whose cells do not match their columns' declared count",
    ceiling: 6,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "each row writes an unescaped pipe inside a cell — a SQL `||` concatenation, an enum " +
      "alternation — so markdown ends the cell there and the rest of its prose never renders. " +
      "Repairing a row means escaping the pipe, which lowers this by one",
  },
  {
    what: "decision-log rows a blank line left outside every table",
    ceiling: 96,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "one blank line at :369 ends the seeded-decisions table, so DEC-0115 onward stop rendering as " +
      "rows and become pipe-delimited paragraphs. They still grep, which is what makes this quiet; " +
      "the number counts rows, not the one cause, so removing the blank line takes it to zero",
  },
  {
    what: "decision-log rows written on another record's line instead of below it",
    ceiling: 1,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "DEC-0123 sits after DEC-0122 on the same line, separated by `||` where a line break belongs. " +
      "The record's cells are intact and it is read; what the line costs is its own line number",
  },
  {
    what: "decision-log rows whose Date cell does not hold a date",
    ceiling: 1,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "DEC-0095's Date cell holds `accepted`, copied out of the Status column. The row records no " +
      "date and the Index column that exists to carry one is empty",
  },
  {
    what: "decision-log supersede claims that cannot be true",
    ceiling: 1,
    measuredBy: "node --import tsx scripts/project/verify-register.ts",
    reason:
      "DEC-0010's Supersedes cell holds `DEC-0153`, a newer id, so the column's direction is " +
      "reversed on that row: it records being superseded on the row that was superseded. The other " +
      "404 cells state no single classifiable claim and are not read",
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
};

/**
 * Every obligation with the number its own detector produces.
 *
 * ONE DISPATCHER, so the ceiling can never be asserted against a detector that only one of the two
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

  const detect = (what: string): number => {
    switch (what) {
      case "distinct live debt items carrying no anchor at all":
        return anchorlessLiveIds(items).length;
      case "items a discharged section declares discharged whose anchor line carries no mark":
        return dischargedWithoutMark(items).length;
      case "decision-log rows whose cells do not match their columns' declared count":
        return rowsOffColumnCount(records).length;
      case "decision-log rows a blank line left outside every table":
        return orphanedDecisionRows(log, decisionLogFile).length;
      case "decision-log rows written on another record's line instead of below it":
        return gluedRecords(records).length;
      case "decision-log rows whose Date cell does not hold a date":
        return rowsWithNonDate(records).length;
      case "decision-log supersede claims that cannot be true":
        return supersedesFindings(records).length;
      default:
        throw new Error(`no measurement is wired for the obligation ${JSON.stringify(what)}`);
    }
  };

  return REGISTER_OBLIGATIONS.map((obligation) => ({
    obligation,
    measured: detect(obligation.what),
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
    canonicalAnchoredLive: new Set(
      live
        .filter((item) => item.anchor !== null && CANONICAL_ANCHOR.test(item.anchor))
        .map((item) => item.id),
    ).size,
    bareAnchoredLive: bareAnchoredLiveIds(items).length,
  };
}
