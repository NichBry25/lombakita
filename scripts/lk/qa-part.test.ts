// @vitest-environment node

/**
 * The QA script, run as a process over a throwaway git repository.
 *
 * Every fixture is a clean part that passes all seven checks, and each test changes only what it
 * names. A check test asserts the whole printed output and the status. A refusal test asserts an
 * empty stdout, the first stderr line and status 1. Fixtures live in a temporary folder that is
 * removed in a `finally`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SLUG = "s";
const WORK = `.work/${SLUG}`;
const FILE_A = "src/a.ts";
const FILE_B = "src/b.ts";
const ESCAPING_PATH = "../evidence.txt";
const ZERO_COMMIT = "0".repeat(40);

const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;
const scriptPath = join(process.cwd(), "scripts/lk/qa-part.ts");

const runQa = (cwd: string) =>
  spawnSync("node", ["--import", tsxLoader, scriptPath, SLUG], { cwd, encoding: "utf8" });

const withWorkspace = <T>(body: (folder: string) => T): T => {
  const folder = mkdtempSync(join(tmpdir(), "lk-qa-part-"));
  try {
    return body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const git = (folder: string, args: string[]): string =>
  execFileSync("git", args, { cwd: folder, encoding: "utf8", stdio: "pipe" });

const writeFiles = (folder: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(folder, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
};

const basePromptLines = (start: string): string[] => [
  `QA start: ${start}`,
  `QA allowed: ${FILE_A}`,
  `QA gate: lint ${WORK}/out/gate-lint.txt`,
  `QA reading: r1 ${WORK}/out/r1-run.txt ${WORK}/out/r1-restore.txt`,
  `QA evidence: ${WORK}/out/evidence.txt`,
];

/** A null value means the file is not written. */
const baseWorkFiles = (): Record<string, string | null> => ({
  [`${WORK}/out/gate-lint.txt`]: "0 errors\nGATE lint PASS\n",
  [`${WORK}/out/r1-run.txt`]: "Tests 1 failed\n",
  [`${WORK}/out/r1-restore.txt`]: "",
  [`${WORK}/out/evidence.txt`]: "ok\n",
  [`${WORK}/03-report.md`]: "report\n",
});

interface FixtureChanges {
  /** Default true. False leaves HEAD at the start commit. */
  partCommit?: boolean;
  /** Files added to the part commit. */
  committedFiles?: Record<string, string>;
  /** Text written over the part's file after the part commit, and not committed. */
  uncommittedText?: string;
  promptLines?: (start: string) => string[];
  workFiles?: Record<string, string | null>;
}

const buildFixture = (folder: string, changes: FixtureChanges): string => {
  git(folder, ["init"]);
  git(folder, ["config", "user.name", "QA Fixture"]);
  git(folder, ["config", "user.email", "qa@fixture.local"]);
  git(folder, ["config", "commit.gpgsign", "false"]);
  writeFiles(folder, {
    "package.json": "{}",
    ".gitignore": ".work/\n",
    [FILE_A]: "export const a = 1;\n",
  });
  git(folder, ["add", "-A"]);
  git(folder, ["commit", "-m", "start"]);
  const start = git(folder, ["rev-parse", "HEAD"]).trim();
  if (changes.partCommit !== false) {
    writeFiles(folder, { [FILE_A]: "export const a = 2;\n", ...changes.committedFiles });
    git(folder, ["add", "-A"]);
    git(folder, ["commit", "-m", "part"]);
  }
  if (changes.uncommittedText !== undefined) {
    writeFiles(folder, { [FILE_A]: changes.uncommittedText });
  }
  const promptLines = (changes.promptLines ?? basePromptLines)(start);
  const workFiles = { ...baseWorkFiles(), ...changes.workFiles };
  const written: Record<string, string> = {
    [`${WORK}/02-prompt.md`]: promptLines.join("\n") + "\n",
  };
  for (const [path, text] of Object.entries(workFiles)) {
    if (text !== null) written[path] = text;
  }
  writeFiles(folder, written);
  return start;
};

const runFixture = (changes: FixtureChanges = {}) =>
  withWorkspace((folder) => {
    const start = buildFixture(folder, changes);
    const result = runQa(folder);
    return { result, short: start.slice(0, 7), start };
  });

const stdoutLines = (stdout: string): string[] => stdout.trimEnd().split("\n");

const firstStderrLine = (stderr: string): string => stderr.split("\n")[0] ?? "";

const passingLines = (short: string): string[] => [
  `PASS commits: 1 new since ${short}`,
  "PASS files: 1 changed, all on the allowed list",
  "PASS tree: clean",
  `PASS gate lint: ${WORK}/out/gate-lint.txt`,
  "PASS reading r1: ran and restored",
  `PASS evidence: ${WORK}/out/evidence.txt`,
  `PASS report: ${WORK}/03-report.md`,
  "lk-qa: PASS, 7 checks",
];

/** The passing lines with the line at `position` (from 0) replaced and the summary set to one failure. */
const withOneFailure = (short: string, position: number, failLine: string): string[] => {
  const lines = passingLines(short);
  lines[position] = failLine;
  lines[lines.length - 1] = "lk-qa: 1 failed of 7 checks";
  return lines;
};

const expectRefusal = (changes: FixtureChanges, refusalLine: string): void => {
  const { result } = runFixture(changes);
  expect(result.stdout).toBe("");
  expect(firstStderrLine(result.stderr)).toBe(refusalLine);
  expect(result.status).toBe(1);
};

describe("the QA checks", () => {
  it("prints PASS for every check of a clean part", () => {
    const { result, short } = runFixture();
    expect(stdoutLines(result.stdout)).toEqual(passingLines(short));
    expect(result.status).toBe(0);
  });

  it("fails a changed file that is not on the allowed list", () => {
    const { result, short } = runFixture({ committedFiles: { [FILE_B]: "export const b = 1;\n" } });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 1, `FAIL files: ${FILE_B} is not on the allowed list`),
    );
    expect(result.status).toBe(1);
  });

  it("fails an uncommitted change", () => {
    const { result, short } = runFixture({ uncommittedText: "export const a = 3;\n" });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 2, `FAIL tree: uncommitted " M ${FILE_A}"`),
    );
    expect(result.status).toBe(1);
  });

  it("fails a gate whose output ends with its FAIL line", () => {
    const { result, short } = runFixture({
      workFiles: { [`${WORK}/out/gate-lint.txt`]: "0 errors\nGATE lint FAIL\n" },
    });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 3, "FAIL gate lint: printed GATE lint FAIL"),
    );
    expect(result.status).toBe(1);
  });

  it("fails a gate whose output file is missing", () => {
    const { result, short } = runFixture({ workFiles: { [`${WORK}/out/gate-lint.txt`]: null } });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 3, `FAIL gate lint: no file at ${WORK}/out/gate-lint.txt`),
    );
    expect(result.status).toBe(1);
  });

  it("fails a gate whose last line is not its GATE line", () => {
    const { result, short } = runFixture({
      workFiles: { [`${WORK}/out/gate-lint.txt`]: "0 errors\n" },
    });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 3, "FAIL gate lint: the last line is not GATE lint PASS"),
    );
    expect(result.status).toBe(1);
  });

  it("fails a reading whose restore check shows a difference", () => {
    const { result, short } = runFixture({
      workFiles: { [`${WORK}/out/r1-restore.txt`]: `diff --git a/${FILE_A} b/${FILE_A}\n` },
    });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 4, "FAIL reading r1: the restore check shows a difference"),
    );
    expect(result.status).toBe(1);
  });

  it("fails a reading with no restore check file", () => {
    const { result, short } = runFixture({ workFiles: { [`${WORK}/out/r1-restore.txt`]: null } });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 4, `FAIL reading r1: no restore check at ${WORK}/out/r1-restore.txt`),
    );
    expect(result.status).toBe(1);
  });

  it("fails when HEAD is still the start commit", () => {
    const { result, short } = runFixture({ partCommit: false });
    const expected = withOneFailure(
      short,
      0,
      `FAIL commits: HEAD is still the start commit ${short}`,
    );
    expected[1] = "PASS files: 0 changed, all on the allowed list";
    expect(stdoutLines(result.stdout)).toEqual(expected);
    expect(result.status).toBe(1);
  });

  it("fails a missing report", () => {
    const { result, short } = runFixture({ workFiles: { [`${WORK}/03-report.md`]: null } });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 6, `FAIL report: ${WORK}/03-report.md is missing or empty`),
    );
    expect(result.status).toBe(1);
  });

  it("fails an empty evidence file", () => {
    const { result, short } = runFixture({ workFiles: { [`${WORK}/out/evidence.txt`]: "" } });
    expect(stdoutLines(result.stdout)).toEqual(
      withOneFailure(short, 5, `FAIL evidence: ${WORK}/out/evidence.txt is missing or empty`),
    );
    expect(result.status).toBe(1);
  });

  it("allows a changed file named on the New paths line", () => {
    const { result, short } = runFixture({
      committedFiles: { [FILE_B]: "export const b = 1;\n" },
      promptLines: (start) => [...basePromptLines(start), `New paths: ${FILE_B}`],
    });
    const expected = passingLines(short);
    expected[1] = "PASS files: 2 changed, all on the allowed list";
    expect(stdoutLines(result.stdout)).toEqual(expected);
    expect(result.status).toBe(0);
  });
});

describe("the QA refusals", () => {
  it("refuses an unknown QA kind", () => {
    expectRefusal(
      { promptLines: (start) => [...basePromptLines(start), "QA gates: lint x"] },
      'LK REFUSED: line 6: unknown QA kind "gates"',
    );
  });

  it("refuses a prompt with no QA start line", () => {
    expectRefusal(
      { promptLines: (start) => basePromptLines(start).slice(1) },
      "LK REFUSED: the prompt has no QA start line",
    );
  });

  it("refuses a path that leaves the repository", () => {
    expectRefusal(
      {
        promptLines: (start) => [
          ...basePromptLines(start).slice(0, 4),
          `QA evidence: ${ESCAPING_PATH}`,
        ],
      },
      `LK REFUSED: line 5: path "${ESCAPING_PATH}" is absolute or leaves the repository`,
    );
  });

  it("refuses a gate id used twice", () => {
    expectRefusal(
      {
        promptLines: (start) => [
          ...basePromptLines(start),
          `QA gate: lint ${WORK}/out/gate-lint-2.txt`,
        ],
      },
      'LK REFUSED: line 6: QA gate id "lint" is used twice',
    );
  });

  it("refuses a gate line with the wrong field count", () => {
    expectRefusal(
      {
        promptLines: (start) => {
          const lines = basePromptLines(start);
          lines[2] = "QA gate: lint";
          return lines;
        },
      },
      "LK REFUSED: line 3: QA gate needs 2 field(s), found 1",
    );
  });

  it("refuses a start commit that is not in the repository", () => {
    expectRefusal(
      {
        promptLines: (start) => {
          const lines = basePromptLines(start);
          lines[0] = `QA start: ${ZERO_COMMIT}`;
          return lines;
        },
      },
      `LK REFUSED: the start commit ${ZERO_COMMIT} is not in this repository`,
    );
  });
});
