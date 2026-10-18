/**
 * The decision files gate: what must hold before a close may rely on `project/decisions/` and the
 * tables generated from it.
 *
 * Run:  node --import tsx scripts/project/decisions-check.ts [--docs <dir>]
 *
 * Exits 1 and prints the id and the reason for every failure. A directory it cannot read, or a log
 * it cannot render, is a failure and never an empty pass. A fresh render of the log is also read by
 * the register census, so a decision the check lets through cannot be one the register gate rejects.
 */

import { join } from "node:path";
import {
  DECISIONS_DIR_IN_DOCS,
  DECISION_LOG_IN_DOCS,
  DECISION_STATUSES,
  NOTE_STATUS,
  DecisionRefusal,
  docsDirectory,
  isDecisionId,
  isKnownType,
  readDecisionDirectory,
  readDecisionLog,
  renderDecisionLog,
  type DecisionDirectory,
  type DecisionFile,
  type DecisionProblem,
} from "./decision-files";
import {
  decisionRecords,
  gluedRecords,
  orphanedDecisionRows,
  rowsOffColumnCount,
  rowsWithNonDate,
  type DecisionRow,
} from "./register-census";

/**
 * A `DEC-` followed by digits and then any letters or digits, so `DEC-00012` and `DEC-0001x` are
 * read as ids that have no file rather than as DEC-0001. A word such as `DEC-logged` has no digits
 * and is prose. A leading letter or digit means the text is part of another word.
 */
const DEC_TOKEN = /(?<![A-Za-z0-9])DEC-\d+[A-Za-z0-9]*/g;

const requiredFieldProblems = (name: string, d: DecisionFile): DecisionProblem[] =>
  (["type", "title", "status", "date", "owner"] as const)
    .filter((field) => d[field].trim() === "")
    .map((field) => ({ subject: name, reason: `${field} is empty` }));

const statusProblem = (name: string, d: DecisionFile): DecisionProblem[] => {
  const allowed: readonly string[] = d.type === "note" ? [NOTE_STATUS] : DECISION_STATUSES;
  if (d.status === "" || allowed.includes(d.status)) return [];
  return [{ subject: name, reason: `status "${d.status}" is not one of: ${allowed.join(", ")}` }];
};

/** A value that would split a table row into two lines or into extra cells. */
const rowShapeProblems = (name: string, d: DecisionFile): DecisionProblem[] => {
  const values: [string, string | null][] = [
    ["id", d.id],
    ["type", d.type],
    ["title", d.title],
    ["index_title", d.indexTitle],
    ["status", d.status],
    ["date", d.date],
    ["owner", d.owner],
    ["supersedes", d.supersedes],
    ["rationale", d.rationale],
  ];
  return values.flatMap(([field, value]) => {
    if (value === null) return [];
    if (/[\r\n]/.test(value)) {
      return [{ subject: name, reason: `${field} contains a line break` }];
    }
    if (/(?<!\\)\|/.test(value)) {
      return [{ subject: name, reason: `${field} contains an unescaped |` }];
    }
    return [];
  });
};

const indexTitleProblems = (name: string, d: DecisionFile): DecisionProblem[] => {
  if (d.indexTitle === null) return [];
  if (d.indexTitle.trim() === "") {
    return [{ subject: name, reason: "index_title is empty; omit the line to show the title" }];
  }
  if (d.indexTitle === d.title) {
    return [{ subject: name, reason: "index_title equals title; omit the line" }];
  }
  return [];
};

const identityProblems = (name: string, d: DecisionFile): DecisionProblem[] => {
  const problems: DecisionProblem[] = [];
  if (d.id !== name.replace(/\.md$/, ""))
    problems.push({ subject: name, reason: `id "${d.id}" does not equal the file name` });
  if (!isKnownType(d.type)) {
    if (d.type !== "")
      problems.push({ subject: name, reason: `type "${d.type}" is not decision or note` });
  } else if (d.type === "decision" && !isDecisionId(d.id)) {
    problems.push({ subject: name, reason: `a decision needs a DEC-dddd id, not "${d.id}"` });
  } else if (d.type === "note" && !d.id.startsWith("NOTE-")) {
    problems.push({ subject: name, reason: `a note needs a NOTE- id, not "${d.id}"` });
  }
  return problems;
};

const duplicateIdProblems = (entries: DecisionDirectory["entries"]): DecisionProblem[] => {
  const seen = new Map<string, string>();
  const problems: DecisionProblem[] = [];
  for (const { fileName, decision } of entries) {
    const first = seen.get(decision.id);
    if (first === undefined) seen.set(decision.id, fileName);
    else
      problems.push({ subject: fileName, reason: `duplicate id ${decision.id}, also in ${first}` });
  }
  return problems;
};

const supersedesProblems = (name: string, d: DecisionFile, ids: Set<string>): DecisionProblem[] =>
  (d.supersedes.match(DEC_TOKEN) ?? [])
    .filter((token) => !ids.has(token))
    .map((token) => ({
      subject: name,
      reason: `supersedes names ${token}, which has no decision file`,
    }));

const censusProblem = (what: string, rows: DecisionRow[]): DecisionProblem[] =>
  rows.length === 0
    ? []
    : [
        {
          subject: DECISION_LOG_IN_DOCS,
          reason: `${what}: ${rows.length} (${rows.map((row) => row.id).join(", ")})`,
        },
      ];

/** What the register census would count in a fresh render of the log, using the census's own readers. */
const censusProblems = (fresh: string): DecisionProblem[] => {
  const records = decisionRecords(fresh, DECISION_LOG_IN_DOCS);
  return [
    ...censusProblem("rows outside every table", orphanedDecisionRows(fresh, DECISION_LOG_IN_DOCS)),
    ...censusProblem(
      "rows written on another row's line",
      gluedRecords(records).map((record) => record.row),
    ),
    ...censusProblem(
      "rows whose cell count is not their columns' count",
      rowsOffColumnCount(records).map((record) => record.row),
    ),
    ...censusProblem("rows whose Date cell does not hold a date", rowsWithNonDate(records)),
  ];
};

const logProblems = (docs: string, files: DecisionFile[]): DecisionProblem[] => {
  let onDisk: string;
  let fresh: string;
  try {
    onDisk = readDecisionLog(docs);
    fresh = renderDecisionLog(onDisk, files);
  } catch (error) {
    if (!(error instanceof DecisionRefusal)) throw error;
    return [{ subject: error.subject, reason: error.reason }];
  }
  const drift: DecisionProblem[] =
    fresh === onDisk
      ? []
      : [
          {
            subject: DECISION_LOG_IN_DOCS,
            reason: "a generated region differs from a fresh build; run npm run decisions:build",
          },
        ];
  return [...drift, ...censusProblems(fresh)];
};

const main = (): void => {
  let problems: DecisionProblem[];
  let count = 0;
  try {
    const docs = docsDirectory(process.argv);
    const directory = readDecisionDirectory(join(docs, DECISIONS_DIR_IN_DOCS));
    const { entries } = directory;
    const files = entries.map((entry) => entry.decision);
    count = entries.length + directory.problems.length;
    const ids = new Set(files.map((d) => d.id));

    problems = [
      ...directory.problems,
      ...duplicateIdProblems(entries),
      ...entries.flatMap(({ fileName, decision }) => [
        ...identityProblems(fileName, decision),
        ...rowShapeProblems(fileName, decision),
        ...indexTitleProblems(fileName, decision),
        ...requiredFieldProblems(fileName, decision),
        ...statusProblem(fileName, decision),
        ...supersedesProblems(fileName, decision, ids),
      ]),
      ...(directory.problems.length === 0 ? logProblems(docs, files) : []),
    ];
  } catch (error) {
    if (!(error instanceof DecisionRefusal)) throw error;
    problems = [{ subject: error.subject, reason: error.reason }];
  }

  for (const problem of problems) console.error(`FAIL  ${problem.subject}: ${problem.reason}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} DECISION CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log(`decisions:check  ${count} files, ALL DECISION CHECKS PASSED`);
};

main();
