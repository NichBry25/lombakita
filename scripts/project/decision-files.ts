/**
 * Decision files: one file per decision under `project/decisions/`, and the generated tables in
 * `project/decision-log.md` that are rendered from them.
 *
 * A decision file is a header block between two `---` lines followed by the rationale as the body.
 * A header value is everything after `key: ` to the end of the line, verbatim. It is never quoted
 * and never parsed as YAML, because a title or rationale may hold colons, quotes and pipes that
 * YAML would read as syntax.
 *
 * The log carries two generated regions. Each is a whole table, header and delimiter rows included,
 * with its begin marker line above the header row and its end marker line below the last row, so
 * the markers sit outside the table and a table reader still sees one unbroken table. Everything
 * between a pair of markers is replaced wholesale on every build, so a hand edit there is drift
 * and `decisions:check` reports it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DECISIONS_DIR_IN_DOCS = "project/decisions";
export const DECISION_LOG_IN_DOCS = "project/decision-log.md";

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

/** A file that cannot be read as a decision, or a log that cannot take generated regions. */
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

/** Reads every `*.md` file in the directory except names starting with `_`. Never throws on content. */
export function readDecisionDirectory(directory: string): DecisionDirectory {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".md") && !name.startsWith("_"));
  } catch {
    throw new DecisionRefusal(directory, "the decisions directory could not be read");
  }

  const entries: DecisionDirectory["entries"] = [];
  const problems: DecisionProblem[] = [];
  for (const fileName of names.sort()) {
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

/** DEC rows in ascending numeric id, then notes by ascending file name. */
export function orderDecisions(files: DecisionFile[]): DecisionFile[] {
  const unknown = files.find((file) => file.type !== "decision" && file.type !== "note");
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

function markerIndex(lines: string[], marker: string): number {
  const found = lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  if (found.length !== 1) {
    throw new DecisionRefusal(
      DECISION_LOG_IN_DOCS,
      `expected exactly one ${marker} line, found ${found.length}`,
    );
  }
  return found[0] as number;
}

/** The log text with both generated regions and the intro count replaced by a fresh render. */
export function renderDecisionLog(logText: string, files: DecisionFile[]): string {
  const lines = logText.split("\n");
  const indexBegin = markerIndex(lines, INDEX_BEGIN);
  const indexEnd = markerIndex(lines, INDEX_END);
  const seededBegin = markerIndex(lines, SEEDED_BEGIN);
  const seededEnd = markerIndex(lines, SEEDED_END);
  if (!(indexBegin < indexEnd && indexEnd < seededBegin && seededBegin < seededEnd)) {
    throw new DecisionRefusal(
      DECISION_LOG_IN_DOCS,
      "the four markers are not in index-begin, index-end, seeded-begin, seeded-end order",
    );
  }

  for (const at of [indexBegin, seededBegin]) {
    if (lines[at - 1]?.startsWith("|")) {
      throw new DecisionRefusal(
        DECISION_LOG_IN_DOCS,
        `line ${at + 1}: a begin marker must sit above its table, not under a table line`,
      );
    }
  }
  for (const at of [indexEnd, seededEnd]) {
    if (lines[at + 1]?.startsWith("|")) {
      throw new DecisionRefusal(
        DECISION_LOG_IN_DOCS,
        `line ${at + 1}: an end marker must sit below its table, not above a table line`,
      );
    }
  }

  const ordered = orderDecisions(files);
  const decisions = ordered.filter((file) => file.type === "decision");
  const highest = decisions[decisions.length - 1]?.id;
  if (highest === undefined)
    throw new DecisionRefusal(DECISION_LOG_IN_DOCS, "there are no decision files to render");

  const introAt = lines.findIndex((line) => INTRO_LEAD.test(line));
  if (introAt === -1 || introAt > indexBegin) {
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
    ...lines.slice(0, indexBegin + 1),
    ...INDEX_TABLE_HEAD,
    ...decisions.map(formatIndexRow),
    ...lines.slice(indexEnd, seededBegin + 1),
    ...SEEDED_TABLE_HEAD,
    ...ordered.map(formatSeededRow),
    ...lines.slice(seededEnd),
  ];
  rendered[introAt] = intro;
  return rendered.join("\n");
}
