/**
 * Decision files: one file per decision under `project/decisions/`, and the generated tables
 * rendered from them: the index in `project/decision-log.md` and the full table in
 * `project/decision-table.md`.
 *
 * A decision file is a header block between two `---` lines followed by the rationale as the body.
 * A header value is everything after `key: ` to the end of the line, verbatim. It is never quoted
 * and never parsed as YAML, because a title or rationale may hold colons, quotes and pipes that
 * YAML would read as syntax.
 *
 * Each of the two files carries one generated region. Each is a whole table, header and delimiter
 * rows included, with its begin marker line above the header row and its end marker line below the
 * last row, so the markers sit outside the table and a table reader still sees one unbroken table.
 * Everything between a pair of markers is replaced wholesale on every build, so a hand edit there is
 * drift and `decisions:check` reports it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DECISIONS_DIR_IN_DOCS = "project/decisions";
export const DECISION_LOG_IN_DOCS = "project/decision-log.md";
export const DECISION_TABLE_IN_DOCS = "project/decision-table.md";

export const INDEX_BEGIN = "<!-- decisions:index:begin -->";
export const INDEX_END = "<!-- decisions:index:end -->";
export const SEEDED_BEGIN = "<!-- decisions:seeded:begin -->";
export const SEEDED_END = "<!-- decisions:seeded:end -->";

const INDEX_TABLE_HEAD = ["| ID | Decision | Status | Date |", "|---|---|---|---|"];
const SEEDED_TABLE_HEAD = [
  "| Decision ID | Title | Status | Date | Owner | Rationale | Supersedes |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];

export const DECISION_STATUSES = [
  "accepted",
  "proposed",
  "rejected",
  "superseded",
  "superseded in part",
] as const;
export const NOTE_STATUS = "note";

export type DecisionType = "decision" | "note";

export interface DecisionFile {
  id: string;
  type: DecisionType;
  title: string;
  /** Present only when the Index table shows a different title from the Seeded table. */
  indexTitle: string | null;
  status: string;
  date: string;
  owner: string;
  supersedes: string;
  rationale: string;
}

/**
 * A file that cannot be read as a decision, or a log or table that cannot take generated regions.
 */
export class DecisionRefusal extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`${subject}: ${reason}`);
    this.name = "DecisionRefusal";
  }
}

const DEC_ID = /^DEC-(\d{4})$/;
const FENCE = "---";
const HEADER_KEYS = [
  "id",
  "type",
  "title",
  "index_title",
  "status",
  "date",
  "owner",
  "supersedes",
] as const;

/** `DEC-dddd.md` or `NOTE-<name>.md`, case-sensitive. */
const DECISION_FILE_NAME = /^(DEC-[0-9]{4}|NOTE-.+)\.md$/;

export const isKnownType = (type: string): type is DecisionType =>
  type === "decision" || type === "note";

/** The directory after `--docs`, or `docs` when the flag is absent. */
export function docsDirectory(argv: string[]): string {
  const at = argv.indexOf("--docs");
  if (at === -1) return "docs";
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DecisionRefusal("--docs", "needs a directory");
  }
  return value;
}

export const isDecisionId = (id: string): boolean => DEC_ID.test(id);

export const decisionNumber = (id: string): number => {
  const match = DEC_ID.exec(id);
  if (match === null) throw new DecisionRefusal(id, "not a DEC id");
  return Number(match[1]);
};

const headerLine = (key: string, value: string): string =>
  value === "" ? `${key}:` : `${key}: ${value}`;

export function formatDecisionFile(decision: DecisionFile): string {
  const lines = [
    FENCE,
    headerLine("id", decision.id),
    headerLine("type", decision.type),
    headerLine("title", decision.title),
  ];
  if (decision.indexTitle !== null) lines.push(headerLine("index_title", decision.indexTitle));
  lines.push(
    headerLine("status", decision.status),
    headerLine("date", decision.date),
    headerLine("owner", decision.owner),
    headerLine("supersedes", decision.supersedes),
    FENCE,
    decision.rationale,
  );
  return `${lines.join("\n")}\n`;
}

export function parseDecisionFile(fileName: string, text: string): DecisionFile {
  const lines = text.split("\n");
  if (lines[0] !== FENCE) throw new DecisionRefusal(fileName, "does not open with a --- line");
  const close = lines.indexOf(FENCE, 1);
  if (close === -1) throw new DecisionRefusal(fileName, "the header block has no closing --- line");

  const values = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon);
    if (!(HEADER_KEYS as readonly string[]).includes(key)) {
      throw new DecisionRefusal(fileName, `unknown header line "${line}"`);
    }
    if (values.has(key)) throw new DecisionRefusal(fileName, `header key "${key}" appears twice`);
    values.set(key, line.slice(colon + 1).replace(/^ /, ""));
  }

  const missing = HEADER_KEYS.filter((key) => key !== "index_title" && !values.has(key));
  if (missing.length > 0) {
    throw new DecisionRefusal(fileName, `missing header line(s): ${missing.join(", ")}`);
  }

  const body = lines.slice(close + 1).join("\n");
  const type = values.get("type") as string;

  return {
    id: values.get("id") as string,
    type: type as DecisionType,
    title: values.get("title") as string,
    indexTitle: values.get("index_title") ?? null,
    status: values.get("status") as string,
    date: values.get("date") as string,
    owner: values.get("owner") as string,
    supersedes: values.get("supersedes") as string,
    rationale: body.endsWith("\n") ? body.slice(0, -1) : body,
  };
}

export interface DecisionProblem {
  /** The file name, or the id when the problem is between files. */
  subject: string;
  reason: string;
}

export interface DecisionDirectory {
  entries: { fileName: string; decision: DecisionFile }[];
  problems: DecisionProblem[];
}

/**
 * Reads every entry of the directory except names starting with `.` or `_`: Finder metadata and
 * editor swap files are written by tools rather than by a person adding a decision, and `_` marks
 * the template. An entry whose name is not `DEC-dddd.md` or `NOTE-<name>.md` is reported as a
 * problem rather than skipped. Never throws on the content of a file; an entry that cannot be read
 * as a file, such as a directory named like a decision, is rethrown as the filesystem error.
 */
export function readDecisionDirectory(directory: string): DecisionDirectory {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => !name.startsWith(".") && !name.startsWith("_"));
  } catch {
    throw new DecisionRefusal(directory, "the decisions directory could not be read");
  }

  const entries: DecisionDirectory["entries"] = [];
  const problems: DecisionProblem[] = [];
  for (const fileName of names.sort()) {
    if (!DECISION_FILE_NAME.test(fileName)) {
      problems.push({
        subject: fileName,
        reason: "is not a decision file name; expected DEC-dddd.md or NOTE-<name>.md",
      });
      continue;
    }
    try {
      const decision = parseDecisionFile(fileName, readFileSync(join(directory, fileName), "utf8"));
      entries.push({ fileName, decision });
    } catch (error) {
      if (!(error instanceof DecisionRefusal)) throw error;
      problems.push({ subject: fileName, reason: error.reason });
    }
  }
  return { entries, problems };
}

/** Refuses the first file whose type is neither decision nor note, naming the file. */
export function refuseUnknownTypes(entries: DecisionDirectory["entries"]): void {
  const unknown = entries.find((entry) => !isKnownType(entry.decision.type));
  if (unknown !== undefined) {
    throw new DecisionRefusal(
      unknown.fileName,
      `type "${unknown.decision.type}" is not decision or note`,
    );
  }
}

/** The text of `project/decision-log.md` under the docs directory. */
export function readDecisionLog(docs: string): string {
  try {
    return readFileSync(join(docs, DECISION_LOG_IN_DOCS), "utf8");
  } catch {
    throw new DecisionRefusal(DECISION_LOG_IN_DOCS, "could not be read");
  }
}

/** The text of `project/decision-table.md` under the docs directory, refusing one that is blank. */
export function readDecisionTable(docs: string): string {
  let text: string;
  try {
    text = readFileSync(join(docs, DECISION_TABLE_IN_DOCS), "utf8");
  } catch {
    throw new DecisionRefusal(DECISION_TABLE_IN_DOCS, "could not be read");
  }
  if (text.trim() === "") throw new DecisionRefusal(DECISION_TABLE_IN_DOCS, "is empty");
  return text;
}

/** DEC rows in ascending numeric id, then notes by ascending file name. */
export function orderDecisions(files: DecisionFile[]): DecisionFile[] {
  const unknown = files.find((file) => !isKnownType(file.type));
  if (unknown !== undefined) {
    throw new DecisionRefusal(unknown.id, `type "${unknown.type}" is not decision or note`);
  }
  const decisions = files
    .filter((file) => file.type === "decision")
    .sort((a, b) => decisionNumber(a.id) - decisionNumber(b.id));
  const notes = files
    .filter((file) => file.type === "note")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...decisions, ...notes];
}

export const formatIndexRow = (d: DecisionFile): string =>
  `| ${d.id} | ${d.indexTitle ?? d.title} | ${d.status} | ${d.date} |`;

export const formatSeededRow = (d: DecisionFile): string =>
  `| ${d.id} | ${d.title} | ${d.status} | ${d.date} | ${d.owner} | ${d.rationale} | ${d.supersedes} |`;

const INTRO_LEAD = /^[0-9]+ decisions, DEC-0001 to DEC-[0-9]{4}/;

function markerIndex(lines: string[], subject: string, marker: string): number {
  const found = lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  if (found.length !== 1) {
    throw new DecisionRefusal(
      subject,
      `expected exactly one ${marker} line, found ${found.length}`,
    );
  }
  return found[0] as number;
}

/** The 0-based lines of a generated region's two markers. */
type MarkedRegion = { begin: number; end: number };

function markedRegion(
  lines: string[],
  subject: string,
  markers: { begin: string; end: string; order: string },
): MarkedRegion {
  const begin = markerIndex(lines, subject, markers.begin);
  const end = markerIndex(lines, subject, markers.end);
  if (begin >= end) throw new DecisionRefusal(subject, markers.order);
  return { begin, end };
}

const indexRegion = (logLines: string[]): MarkedRegion =>
  markedRegion(logLines, DECISION_LOG_IN_DOCS, {
    begin: INDEX_BEGIN,
    end: INDEX_END,
    order: "the two markers are not in index-begin, index-end order",
  });

const seededRegion = (tableLines: string[]): MarkedRegion =>
  markedRegion(tableLines, DECISION_TABLE_IN_DOCS, {
    begin: SEEDED_BEGIN,
    end: SEEDED_END,
    order: "the two markers are not in seeded-begin, seeded-end order",
  });

function refuseNonRowLinesInRegion(lines: string[], subject: string, region: MarkedRegion): void {
  const stray = lines
    .slice(region.begin + 1, region.end)
    .findIndex((line) => !line.startsWith("|"));
  if (stray !== -1) {
    throw new DecisionRefusal(
      subject,
      `line ${region.begin + stray + 2}: a generated region holds only table rows, and a build would delete this line; move it outside the markers`,
    );
  }
}

function refuseMarkersTouchingTableLines(
  lines: string[],
  subject: string,
  region: MarkedRegion,
): void {
  if (lines[region.begin - 1]?.startsWith("|")) {
    throw new DecisionRefusal(
      subject,
      `line ${region.begin + 1}: a begin marker must sit above its table, not under a table line`,
    );
  }
  if (lines[region.end + 1]?.startsWith("|")) {
    throw new DecisionRefusal(
      subject,
      `line ${region.end + 1}: an end marker must sit below its table, not above a table line`,
    );
  }
}

/** The table lines of a region below its head row and its delimiter row. */
const rowsBelowHead = (lines: string[], region: MarkedRegion): string[] =>
  lines.slice(region.begin + 3, region.end).filter((line) => line.startsWith("|"));

const firstCell = (row: string): string => (row.split("|")[1] ?? "").trim();

/** The log text with its index region and the intro count replaced by a fresh render. */
export function renderDecisionLog(logText: string, files: DecisionFile[]): string {
  const lines = logText.split("\n");
  const index = indexRegion(lines);
  refuseNonRowLinesInRegion(lines, DECISION_LOG_IN_DOCS, index);
  refuseMarkersTouchingTableLines(lines, DECISION_LOG_IN_DOCS, index);

  const decisions = orderDecisions(files).filter((file) => file.type === "decision");
  const highest = decisions[decisions.length - 1]?.id;
  if (highest === undefined)
    throw new DecisionRefusal(DECISION_LOG_IN_DOCS, "there are no decision files to render");

  const introAt = lines.findIndex((line) => INTRO_LEAD.test(line));
  if (introAt === -1 || introAt > index.begin) {
    throw new DecisionRefusal(
      DECISION_LOG_IN_DOCS,
      "no intro line starting with the decisions count above the index table",
    );
  }
  const intro = (lines[introAt] as string).replace(
    INTRO_LEAD,
    `${decisions.length} decisions, DEC-0001 to ${highest}`,
  );

  const rendered = [
    ...lines.slice(0, index.begin + 1),
    ...INDEX_TABLE_HEAD,
    ...decisions.map(formatIndexRow),
    ...lines.slice(index.end),
  ];
  rendered[introAt] = intro;
  return rendered.join("\n");
}

/** The table text with its seeded region replaced by a fresh render. */
export function renderDecisionTable(tableText: string, files: DecisionFile[]): string {
  const lines = tableText.split("\n");
  const seeded = seededRegion(lines);
  refuseNonRowLinesInRegion(lines, DECISION_TABLE_IN_DOCS, seeded);
  refuseMarkersTouchingTableLines(lines, DECISION_TABLE_IN_DOCS, seeded);
  if (rowsBelowHead(lines, seeded).length === 0) {
    throw new DecisionRefusal(
      DECISION_TABLE_IN_DOCS,
      `holds no table row between ${SEEDED_BEGIN} and ${SEEDED_END}`,
    );
  }

  const rendered = [
    ...lines.slice(0, seeded.begin + 1),
    ...SEEDED_TABLE_HEAD,
    ...orderDecisions(files).map(formatSeededRow),
    ...lines.slice(seeded.end),
  ];
  return rendered.join("\n");
}

const TABLE_LINE_PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*/;

/**
 * The first cell of a line that markdown can render as a table line, read after any blockquote
 * markers, indent and list markers, with or without a leading pipe. Null when the line holds no
 * pipe.
 */
export function tableLineFirstCell(line: string): string | null {
  const body = line.replace(TABLE_LINE_PREFIX, "");
  if (!body.includes("|")) return null;
  const cells = body.startsWith("|") ? body.slice(1) : body;
  const cellEnd = cells.indexOf("|");
  const cell = cellEnd === -1 ? cells : cells.slice(0, cellEnd);
  return cell.trim();
}

/**
 * Refuses the first line, the log first, that stands outside both generated regions, that markdown
 * can render as a table line and whose first cell is an id the full table holds: a copy of a record
 * that every census would count twice.
 */
export function refuseStrayDecisionRows(logText: string, tableText: string): void {
  const logLines = logText.split("\n");
  const tableLines = tableText.split("\n");
  const index = indexRegion(logLines);
  const seeded = seededRegion(tableLines);
  const ids = new Set(rowsBelowHead(tableLines, seeded).map(firstCell));

  refuseStrayRowsIn(logLines, DECISION_LOG_IN_DOCS, index, ids);
  refuseStrayRowsIn(tableLines, DECISION_TABLE_IN_DOCS, seeded, ids);
}

function refuseStrayRowsIn(
  lines: string[],
  subject: string,
  region: MarkedRegion,
  ids: Set<string>,
): void {
  const stray = lines.findIndex((line, at) => {
    if (at >= region.begin && at <= region.end) return false;
    const cell = tableLineFirstCell(line);
    return cell !== null && ids.has(cell);
  });
  if (stray === -1) return;
  const id = tableLineFirstCell(lines[stray] as string);
  throw new DecisionRefusal(
    subject,
    `line ${stray + 1}: ${id} heads a full table row outside the generated table of ${DECISION_TABLE_IN_DOCS}`,
  );
}
