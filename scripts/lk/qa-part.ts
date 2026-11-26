/**
 * Prints the mechanical checks of one implementer part, read from the QA lines of its prompt.
 *
 * Run: npm run lk:qa -- <work item slug>   (from the repository root)
 *
 * It reads .work/<slug>/02-prompt.md and the files and git state that the QA lines name. It writes
 * nothing and runs no gate: a gate is checked from the output file the implementer saved. Each check
 * is one line `PASS <text>` or `FAIL <text>`, then the last line `lk-qa: PASS, <n> checks` and exit 0,
 * or `lk-qa: <f> failed of <n> checks` and exit 1. It prints no verdict: the controller decides.
 * A prompt with a missing or malformed QA line, a start commit that is not in the repository, a
 * working directory without a package.json and a wrong argument count are refused through `refuse`
 * from ./models: one line starting `LK REFUSED: ` on stderr, exit 1, nothing on stdout.
 *
 * A QA line is a whole prompt line `QA <kind>: <fields separated by single spaces>`. The paths of the
 * line that starts `New paths: ` join the paths of the `QA allowed` lines, because a path a step
 * creates is listed there.
 *
 * The files and tree checks see only what git tracks or lists as untracked. A path the repository
 * ignores, such as the folders docs, .claude and .work and the file CLAUDE.md here, is never read.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LkRefusal, parseCliArgs, refuse } from "./models";

/** What each part of the QA script reads. A QA line that none of these classifies is refused. */
export const SUBJECT = {
  line: {
    pattern: /^QA ([a-z]+): (.+)$/,
    looksLikeQaLine: /^qa(?![a-z0-9])/i,
    qaLineAfterLead: /^[^a-z0-9]*(?:\d+[.)][^a-z0-9]*)?qa(?![a-z0-9])/i,
    codeFence: /^\s*```[A-Za-z0-9_+-]*\s*$/,
    newPathsPrefix: "New paths: ",
  },
  kinds: ["start", "allowed", "gate", "reading", "evidence"],
  fieldCounts: { start: 1, gate: 2, reading: 3, evidence: 1 },
  startCommit: /^[0-9a-f]{40}$/,
  id: /^[a-z0-9-]+$/,
  slug: /^[a-z0-9-]+$/,
  gitMaxBufferBytes: 64 * 1024 * 1024,
  files: {
    prompt: (slug: string): string => `.work/${slug}/02-prompt.md`,
    report: (slug: string): string => `.work/${slug}/03-report.md`,
  },
} as const;

type QaKind = (typeof SUBJECT.kinds)[number];

export interface QaPlan {
  start: string;
  allowed: string[];
  gates: { id: string; path: string }[];
  readings: { id: string; runPath: string; restorePath: string }[];
  evidence: string[];
}

export interface QaLine {
  status: "PASS" | "FAIL";
  text: string;
}

const pass = (text: string): QaLine => ({ status: "PASS", text });

const fail = (text: string): QaLine => ({ status: "FAIL", text });

const isQaKind = (kind: string): kind is QaKind =>
  (SUBJECT.kinds as readonly string[]).includes(kind);

const splitLines = (text: string): string[] => text.split(/\r?\n/);

const requireRelativePath = (path: string, lineNumber: number): void => {
  const leavesRepository = path.startsWith("/") || path.split("/").includes("..");
  if (!leavesRepository) return;
  refuse(`line ${lineNumber}: path "${path}" is absolute or leaves the repository`);
};

const requireIdUnused = (kind: QaKind, id: string, seenIds: string[], lineNumber: number): void => {
  if (!SUBJECT.id.test(id)) {
    refuse(
      `line ${lineNumber}: QA ${kind} id "${id}" is not lowercase letters, digits and hyphens`,
    );
  }
  if (seenIds.includes(id)) refuse(`line ${lineNumber}: QA ${kind} id "${id}" is used twice`);
};

const requireFieldCount = (kind: QaKind, fields: string[], lineNumber: number): void => {
  if (kind === "allowed") return;
  const expected = SUBJECT.fieldCounts[kind];
  if (fields.length === expected) return;
  refuse(`line ${lineNumber}: QA ${kind} needs ${expected} field(s), found ${fields.length}`);
};

interface PlanDraft {
  starts: string[];
  allowed: string[];
  allowedSourceLines: number;
  gates: QaPlan["gates"];
  readings: QaPlan["readings"];
  evidence: string[];
  /** The line number of the fence that opened the block being skipped, or null outside a block. */
  openFenceLine: number | null;
}

const emptyDraft = (): PlanDraft => ({
  starts: [],
  allowed: [],
  allowedSourceLines: 0,
  gates: [],
  readings: [],
  evidence: [],
  openFenceLine: null,
});

const addAllowedPaths = (draft: PlanDraft, paths: string[], lineNumber: number): void => {
  for (const path of paths) requireRelativePath(path, lineNumber);
  draft.allowed.push(...paths);
  draft.allowedSourceLines += 1;
};

const addStart = (draft: PlanDraft, fields: string[], lineNumber: number): void => {
  const [commit = ""] = fields;
  if (!SUBJECT.startCommit.test(commit)) {
    refuse(`line ${lineNumber}: QA start is not a 40-character lowercase hex commit`);
  }
  draft.starts.push(commit);
};

const addGate = (draft: PlanDraft, fields: string[], lineNumber: number): void => {
  const [id = "", path = ""] = fields;
  requireIdUnused(
    "gate",
    id,
    draft.gates.map((gate) => gate.id),
    lineNumber,
  );
  requireRelativePath(path, lineNumber);
  draft.gates.push({ id, path });
};

const addReading = (draft: PlanDraft, fields: string[], lineNumber: number): void => {
  const [id = "", runPath = "", restorePath = ""] = fields;
  requireIdUnused(
    "reading",
    id,
    draft.readings.map((reading) => reading.id),
    lineNumber,
  );
  requireRelativePath(runPath, lineNumber);
  requireRelativePath(restorePath, lineNumber);
  draft.readings.push({ id, runPath, restorePath });
};

const addEvidence = (draft: PlanDraft, fields: string[], lineNumber: number): void => {
  const [path = ""] = fields;
  requireRelativePath(path, lineNumber);
  draft.evidence.push(path);
};

const addQaLine = (draft: PlanDraft, kind: QaKind, fields: string[], lineNumber: number): void => {
  requireFieldCount(kind, fields, lineNumber);
  if (kind === "start") addStart(draft, fields, lineNumber);
  if (kind === "allowed") addAllowedPaths(draft, fields, lineNumber);
  if (kind === "gate") addGate(draft, fields, lineNumber);
  if (kind === "reading") addReading(draft, fields, lineNumber);
  if (kind === "evidence") addEvidence(draft, fields, lineNumber);
};

const readPromptLine = (draft: PlanDraft, line: string, lineNumber: number): void => {
  if (SUBJECT.line.codeFence.test(line)) {
    draft.openFenceLine = draft.openFenceLine === null ? lineNumber : null;
    return;
  }
  if (draft.openFenceLine !== null) return;
  if (line.startsWith(SUBJECT.line.newPathsPrefix)) {
    const paths = line.slice(SUBJECT.line.newPathsPrefix.length).split(" ");
    addAllowedPaths(draft, paths, lineNumber);
    return;
  }
  const match = SUBJECT.line.pattern.exec(line);
  if (match === null) {
    if (SUBJECT.line.looksLikeQaLine.test(line)) {
      refuse(`line ${lineNumber}: a line that starts with QA must read "QA <kind>: <fields>"`);
    }
    if (SUBJECT.line.qaLineAfterLead.test(line)) {
      refuse(
        `line ${lineNumber}: a QA line must start at the first character of its line, with nothing before it`,
      );
    }
    return;
  }
  const kind = match[1] ?? "";
  if (!isQaKind(kind)) refuse(`line ${lineNumber}: unknown QA kind "${kind}"`);
  addQaLine(draft, kind, (match[2] ?? "").split(" "), lineNumber);
};

const requireNoOpenFence = (draft: PlanDraft): void => {
  if (draft.openFenceLine === null) return;
  refuse(`line ${draft.openFenceLine}: a code fence opened here is not closed`);
};

const planOf = (draft: PlanDraft): QaPlan => {
  const [start] = draft.starts;
  if (start === undefined) return refuse("the prompt has no QA start line");
  if (draft.starts.length > 1) {
    refuse(`the prompt has ${draft.starts.length} QA start lines, one is allowed`);
  }
  if (draft.allowedSourceLines === 0) {
    refuse("the prompt has no QA allowed line and no New paths line");
  }
  return {
    start,
    allowed: draft.allowed,
    gates: draft.gates,
    readings: draft.readings,
    evidence: draft.evidence,
  };
};

export const parseQaLines = (text: string): QaPlan => {
  const draft = emptyDraft();
  splitLines(text).forEach((line, index) => readPromptLine(draft, line, index + 1));
  requireNoOpenFence(draft);
  return planOf(draft);
};

const gitOutput = (root: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: SUBJECT.gitMaxBufferBytes,
  });

const gitSucceeds = (root: string, args: string[]): boolean =>
  spawnSync("git", args, { cwd: root, stdio: "ignore", maxBuffer: SUBJECT.gitMaxBufferBytes })
    .status === 0;

const readTextOrNull = (root: string, path: string): string | null => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

const isBlankOrMissing = (text: string | null): boolean => text === null || text.trim() === "";

const nonEmptyLinesOf = (text: string): string[] =>
  splitLines(text).filter((line) => line.trim() !== "");

const checkCommits = (start: string, root: string): QaLine => {
  const short = start.slice(0, 7);
  const head = gitOutput(root, ["rev-parse", "HEAD"]).trim();
  if (head === start) return fail(`commits: HEAD is still the start commit ${short}`);
  if (!gitSucceeds(root, ["merge-base", "--is-ancestor", start, "HEAD"])) {
    return fail(`commits: the start commit ${short} is not an ancestor of HEAD`);
  }
  const count = gitOutput(root, ["rev-list", "--count", `${start}..HEAD`]).trim();
  return pass(`commits: ${count} new since ${short}`);
};

const checkFiles = (plan: QaPlan, root: string): QaLine[] => {
  const diff = gitOutput(root, ["diff", "--name-only", "--no-renames", plan.start, "HEAD"]);
  const changedPaths = nonEmptyLinesOf(diff);
  if (changedPaths.length === 0) {
    return [fail(`files: no file changed since ${plan.start.slice(0, 7)}`)];
  }
  const offending = changedPaths.filter((path) => !plan.allowed.includes(path));
  if (offending.length === 0) {
    return [pass(`files: ${changedPaths.length} changed, all on the allowed list`)];
  }
  return offending.map((path) => fail(`files: ${path} is not on the allowed list`));
};

const checkTree = (root: string): QaLine[] => {
  const status = gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyLines = status.split("\n").filter((line) => line !== "");
  if (dirtyLines.length === 0) return [pass("tree: clean")];
  return dirtyLines.map((line) => fail(`tree: uncommitted "${line}"`));
};

const checkGate = (gate: QaPlan["gates"][number], root: string): QaLine => {
  const text = readTextOrNull(root, gate.path);
  if (text === null) return fail(`gate ${gate.id}: no file at ${gate.path}`);
  const lastLine = (nonEmptyLinesOf(text).pop() ?? "").trimEnd();
  if (lastLine === `GATE ${gate.id} PASS`) return pass(`gate ${gate.id}: ${gate.path}`);
  if (lastLine === `GATE ${gate.id} FAIL`)
    return fail(`gate ${gate.id}: printed GATE ${gate.id} FAIL`);
  return fail(`gate ${gate.id}: the last line is not GATE ${gate.id} PASS`);
};

const checkReading = (reading: QaPlan["readings"][number], root: string): QaLine => {
  const run = readTextOrNull(root, reading.runPath);
  if (isBlankOrMissing(run))
    return fail(`reading ${reading.id}: no run output at ${reading.runPath}`);
  const restore = readTextOrNull(root, reading.restorePath);
  if (restore === null)
    return fail(`reading ${reading.id}: no restore check at ${reading.restorePath}`);
  if (restore.trim() !== "") {
    return fail(`reading ${reading.id}: the restore check shows a difference`);
  }
  return pass(`reading ${reading.id}: ran and restored`);
};

const checkEvidence = (path: string, root: string): QaLine => {
  if (isBlankOrMissing(readTextOrNull(root, path)))
    return fail(`evidence: ${path} is missing or empty`);
  return pass(`evidence: ${path}`);
};

const checkReport = (slug: string, root: string): QaLine => {
  const reportPath = SUBJECT.files.report(slug);
  if (isBlankOrMissing(readTextOrNull(root, reportPath))) {
    return fail(`report: ${reportPath} is missing or empty`);
  }
  return pass(`report: ${reportPath}`);
};

export const runQaChecks = (plan: QaPlan, root: string, slug: string): QaLine[] => [
  checkCommits(plan.start, root),
  ...checkFiles(plan, root),
  ...checkTree(root),
  ...plan.gates.map((gate) => checkGate(gate, root)),
  ...plan.readings.map((reading) => checkReading(reading, root)),
  ...plan.evidence.map((path) => checkEvidence(path, root)),
  checkReport(slug, root),
];

export const qaReportLinesOf = (lines: QaLine[]): string[] => {
  const checkLines = lines.map((line) => `${line.status} ${line.text}`);
  const failedCount = lines.filter((line) => line.status === "FAIL").length;
  const summary =
    failedCount === 0
      ? `lk-qa: PASS, ${lines.length} checks`
      : `lk-qa: ${failedCount} failed of ${lines.length} checks`;
  return [...checkLines, summary];
};

const slugFromArgs = (args: string[]): string => {
  const { positionals } = parseCliArgs(args, {});
  const [slug] = positionals;
  if (slug === undefined) return refuse("give one work item slug");
  if (positionals.length > 1) refuse(`unexpected argument "${positionals[1]}"`);
  if (!SUBJECT.slug.test(slug)) {
    refuse(`the slug "${slug}" is not lowercase letters, digits and hyphens`);
  }
  return slug;
};

const requireRepositoryRoot = (root: string): void => {
  if (existsSync(join(root, "package.json"))) return;
  refuse(`the current directory ${root} holds no package.json, so it is not the repository root`);
};

const readPrompt = (root: string, slug: string): string => {
  const promptPath = SUBJECT.files.prompt(slug);
  const text = readTextOrNull(root, promptPath);
  if (text === null) return refuse(`no prompt at ${promptPath}`);
  return text;
};

const requireStartCommitInRepository = (start: string, root: string): void => {
  if (gitSucceeds(root, ["cat-file", "-e", `${start}^{commit}`])) return;
  refuse(`the start commit ${start} is not in this repository`);
};

const main = (): void => {
  try {
    const root = process.cwd();
    requireRepositoryRoot(root);
    const slug = slugFromArgs(process.argv.slice(2));
    const plan = parseQaLines(readPrompt(root, slug));
    requireStartCommitInRepository(plan.start, root);
    const lines = runQaChecks(plan, root, slug);
    console.log(qaReportLinesOf(lines).join("\n"));
    process.exitCode = lines.some((line) => line.status === "FAIL") ? 1 : 0;
  } catch (error) {
    if (!(error instanceof LkRefusal)) throw error;
    console.error(`LK REFUSED: ${error.message}`);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
