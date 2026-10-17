/**
 * The decision files gate: what must hold before a close may rely on `project/decisions/` and the
 * tables generated from it.
 *
 * Run:  node --import tsx scripts/project/decisions-check.ts [--docs <dir>]
 *
 * Exits 1 and prints the id and the reason for every failure. A directory it cannot read, or a log
 * it cannot render, is a failure and never an empty pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECISIONS_DIR_IN_DOCS,
  DECISION_LOG_IN_DOCS,
  DECISION_STATUSES,
  NOTE_STATUS,
  DecisionRefusal,
  isDecisionId,
  readDecisionDirectory,
  renderDecisionLog,
  type DecisionDirectory,
  type DecisionFile,
  type DecisionProblem,
} from "./decision-files";

const DEC_TOKEN = /DEC-\d{4}/g;

const docsDirectory = (argv: string[]): string => {
  const at = argv.indexOf("--docs");
  if (at === -1) return "docs";
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--"))
    throw new DecisionRefusal("--docs", "needs a directory");
  return value;
};

const requiredFieldProblems = (name: string, d: DecisionFile): DecisionProblem[] =>
  (["type", "title", "status", "date", "owner"] as const)
    .filter((field) => d[field].trim() === "")
    .map((field) => ({ subject: name, reason: `${field} is empty` }));

const statusProblem = (name: string, d: DecisionFile): DecisionProblem[] => {
  const allowed: readonly string[] = d.type === "note" ? [NOTE_STATUS] : DECISION_STATUSES;
  if (d.status === "" || allowed.includes(d.status)) return [];
  return [{ subject: name, reason: `status "${d.status}" is not one of: ${allowed.join(", ")}` }];
};

const identityProblems = (name: string, d: DecisionFile): DecisionProblem[] => {
  const problems: DecisionProblem[] = [];
  if (d.id !== name.replace(/\.md$/, ""))
    problems.push({ subject: name, reason: `id "${d.id}" does not equal the file name` });
  if (d.type !== "decision" && d.type !== "note") {
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

const generatedRegionProblem = (docs: string, files: DecisionFile[]): DecisionProblem[] => {
  const log = join(docs, DECISION_LOG_IN_DOCS);
  try {
    const onDisk = readFileSync(log, "utf8");
    return renderDecisionLog(onDisk, files) === onDisk
      ? []
      : [
          {
            subject: DECISION_LOG_IN_DOCS,
            reason: "a generated region differs from a fresh build; run npm run decisions:build",
          },
        ];
  } catch (error) {
    if (error instanceof DecisionRefusal) return [{ subject: error.subject, reason: error.reason }];
    return [{ subject: DECISION_LOG_IN_DOCS, reason: "could not be read" }];
  }
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
        ...requiredFieldProblems(fileName, decision),
        ...statusProblem(fileName, decision),
        ...supersedesProblems(fileName, decision, ids),
      ]),
      ...(directory.problems.length === 0 ? generatedRegionProblem(docs, files) : []),
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
