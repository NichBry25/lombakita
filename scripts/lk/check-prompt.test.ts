// @vitest-environment node

/**
 * The prompt checker, one passing and one failing fixture for each check.
 *
 * A failing fixture is a whole prompt that is clean except for the one defect, so the assertion is
 * the exact list of checks and line numbers the checker reports. Files live in a temporary folder
 * that is removed in a `finally`. Only the commit checks read the real repository.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPromptContext,
  checkPromptText,
  reportLinesOf,
  type PromptContext,
} from "./check-prompt";

const SLUG = "slug";
const HEAD_LINES = ["Implementer: Claude", "Tier: 2", "Reviewers: Review A"];
const END_LINE = "END OF PROMPT";
const EM_DASH = "—";
const EN_DASH = "–";

/** A prompt that passes the routing and end checks, with `body` between them. */
const promptOf = (...body: string[]): string => [...HEAD_LINES, ...body, END_LINE].join("\n");

/** 1-based line number of the body line at `position`, counting from 0. */
const bodyLine = (position: number): number => HEAD_LINES.length + 1 + position;

const withWorkspace = <T>(body: (folder: string) => T): T => {
  const folder = mkdtempSync(join(tmpdir(), "lk-check-prompt-"));
  try {
    return body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const writeFiles = (folder: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(folder, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
};

const withRoot = (files: Record<string, string>, body: (context: PromptContext) => void): void => {
  withWorkspace((folder) => {
    writeFiles(folder, { [`.work/${SLUG}/keep.md`]: "kept\n", ...files });
    body(buildPromptContext(folder, SLUG));
  });
};

const realRootContext = (): PromptContext => buildPromptContext(process.cwd(), SLUG);

/** The checks and lines a prompt fails, as `check:line`. */
const failuresOf = (text: string, context: PromptContext): string[] =>
  checkPromptText(text, context).findings.map((item) => `${item.check}:${item.line}`);

const messagesOf = (text: string, context: PromptContext): string[] =>
  checkPromptText(text, context).findings.map((item) => item.message);

describe("routing", () => {
  it("passes when the first three non-empty lines start with the three labels", () => {
    withRoot({}, (context) => {
      const text = ["", ...HEAD_LINES.flatMap((line) => [line, ""]), END_LINE].join("\n");
      expect(failuresOf(text, context)).toEqual([]);
    });
  });

  it("fails on the line whose label is wrong", () => {
    withRoot({}, (context) => {
      const text = ["Implementer: Claude", "Tier: 2", "Review: A", END_LINE].join("\n");
      expect(failuresOf(text, context)).toEqual(["routing:3"]);
    });
  });

  it("fails on line 1 when the first line is wrong", () => {
    withRoot({}, (context) => {
      const text = ["Claude", "Tier: 2", "Reviewers: Review A", END_LINE].join("\n");
      expect(failuresOf(text, context)).toEqual(["routing:1"]);
    });
  });

  it("fails on line 2 when the second line is wrong", () => {
    withRoot({}, (context) => {
      const text = ["Implementer: Claude", "Level: 2", "Reviewers: Review A", END_LINE].join("\n");
      expect(failuresOf(text, context)).toEqual(["routing:2"]);
    });
  });

  it("fails on the last line when there are fewer than three non-empty lines", () => {
    withRoot({}, (context) => {
      const text = ["Implementer: Claude", "", "Tier: 2"].join("\n");
      expect(failuresOf(text, context)).toEqual(["routing:3", "end:3"]);
      expect(messagesOf(text, context)[0]).toBe(
        "non-empty line 3 must start with Reviewers:, found no such line",
      );
    });
  });
});

describe("end", () => {
  it("passes when the last non-empty line is exactly END OF PROMPT, with a trailing newline", () => {
    withRoot({}, (context) => {
      expect(failuresOf(`${promptOf("body")}\n\n`, context)).toEqual([]);
    });
  });

  it("fails on the last non-empty line when it is not exactly END OF PROMPT", () => {
    withRoot({}, (context) => {
      const text = [...HEAD_LINES, "body", `${END_LINE} `, ""].join("\n");
      expect(failuresOf(text, context)).toEqual([`end:${bodyLine(1)}`]);
    });
  });
});

describe("dash", () => {
  it("passes when no line holds an em dash or an en dash", () => {
    withRoot({}, (context) => {
      expect(failuresOf(promptOf("a hyphen - and two -- are fine"), context)).toEqual([]);
    });
  });

  it.each([
    { name: "an em dash", character: EM_DASH, named: "U+2014" },
    { name: "an en dash", character: EN_DASH, named: "U+2013" },
  ])("fails on the line holding $name, once", ({ character, named }) => {
    withRoot({}, (context) => {
      const text = promptOf("clean", `two${character}words${character}here`, "clean");
      expect(failuresOf(text, context)).toEqual([`dash:${bodyLine(1)}`]);
      expect(messagesOf(text, context)).toEqual([`holds ${named}`]);
    });
  });
});

describe("path", () => {
  const files = { "notes/a.txt": "alpha\n" };

  it("passes for existing paths, new paths, the slug folder, templates, links and other roots", () => {
    withRoot(files, (context) => {
      const text = promptOf(
        "Read notes/a.txt, then `notes/a.txt`.",
        "New paths: notes/new.txt, notes/other.txt",
        "Write .work/slug/03-report.md and (.work/slug/out/x.txt).",
        "Skip notes/<name>.txt and notes/*.txt.",
        "See https://example.com/notes/missing and other/missing.txt.",
      );
      expect(failuresOf(text, context)).toEqual([]);
    });
  });

  it("counts the templates in the last line", () => {
    withRoot(files, (context) => {
      const report = checkPromptText(promptOf("Skip notes/<name>.txt and notes/*.txt."), context);
      expect(report.templates).toBe(2);
      expect(reportLinesOf(report)).toEqual(["check-prompt: PASS, templates: 2, unclassified: 0"]);
    });
  });

  it("counts a slash token that is no template, no URL and no root entry, and does not fail it", () => {
    withRoot(files, (context) => {
      const text = promptOf(
        "Choose and/or other/dir/file here.",
        "Skip https://example.com/x, foo/<bar> and notes/a.txt.",
      );
      const report = checkPromptText(text, context);
      expect(report.findings).toEqual([]);
      expect(report.unclassified).toBe(2);
      expect(reportLinesOf(report)).toEqual(["check-prompt: PASS, templates: 0, unclassified: 2"]);
    });
  });

  it("fails a path under the work folder of another slug when it does not exist", () => {
    withRoot(files, (context) => {
      const text = promptOf("fine", "Read .work/other/03-report.md.");
      expect(failuresOf(text, context)).toEqual([`path:${bodyLine(1)}`]);
      expect(messagesOf(text, context)).toEqual([".work/other/03-report.md does not exist"]);
    });
  });

  it("fails on the line naming a path that does not exist", () => {
    withRoot(files, (context) => {
      const text = promptOf("fine", "Read notes/missing.txt.");
      expect(failuresOf(text, context)).toEqual([`path:${bodyLine(1)}`]);
      expect(messagesOf(text, context)).toEqual(["notes/missing.txt does not exist"]);
    });
  });

  it("reads a path with a line suffix without the suffix", () => {
    withRoot(files, (context) => {
      expect(failuresOf(promptOf("Read notes/missing.txt:1."), context)).toEqual([
        `path:${bodyLine(0)}`,
        `line:${bodyLine(0)}`,
      ]);
    });
  });
});

describe("line", () => {
  const files = { "notes/lines.txt": "alpha   beta\ngamma\ndelta\n\n\n" };

  it("passes for lines and ranges inside the file, with text that the lines hold", () => {
    withRoot(files, (context) => {
      const text = promptOf(
        "notes/lines.txt:1",
        "notes/lines.txt:1-3",
        'notes/lines.txt:1 "alpha beta"',
        "`notes/lines.txt:2-3` `gamma`",
        'notes/lines.txt:3: "delta"',
        'notes/lines.txt:1 and "not a quote of it"',
      );
      expect(failuresOf(text, context)).toEqual([]);
    });
  });

  it.each([
    {
      name: "a line past the last non-empty line",
      cite: "notes/lines.txt:4",
      fragment: "past line 3",
    },
    {
      name: "a range ending past the last line",
      cite: "notes/lines.txt:2-9",
      fragment: "past line 3",
    },
    { name: "line 0", cite: "notes/lines.txt:0", fragment: "line number 0" },
    { name: "a range ending at line 0", cite: "notes/lines.txt:1-0", fragment: "line number 0" },
    {
      name: "a range that ends before it starts",
      cite: "notes/lines.txt:3-2",
      fragment: "ends before",
    },
    {
      name: "a quote that the line does not hold",
      cite: 'notes/lines.txt:2 "alpha"',
      fragment: '"alpha" is not in line 2 of notes/lines.txt',
    },
    {
      name: "a quote that the range does not hold",
      cite: "notes/lines.txt:2-3 `omega`",
      fragment: '"omega" is not in lines 2-3 of notes/lines.txt',
    },
    {
      name: "a file that does not exist",
      cite: ".work/slug/absent.md:2",
      fragment: ".work/slug/absent.md is not an existing file",
    },
  ])("fails on $name", ({ cite, fragment }) => {
    withRoot(files, (context) => {
      const text = promptOf("fine", cite);
      expect(failuresOf(text, context)).toEqual([`line:${bodyLine(1)}`]);
      expect(messagesOf(text, context)[0]).toContain(fragment);
    });
  });

  it("takes the last line of the real file the way the checker defines it", () => {
    const real = "scripts/lk/models.ts";
    const lastLine = execFileSync("wc", ["-l", real], { encoding: "utf8" }).trim().split(/\s+/)[0];
    const context = realRootContext();
    expect(failuresOf(promptOf(`${real}:${lastLine}`), context)).toEqual([]);
    expect(failuresOf(promptOf(`${real}:${Number(lastLine) + 1}`), context)).toEqual([
      `line:${bodyLine(0)}`,
    ]);
  });
});

describe("commit", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const absentCommit = "0123456789abcdef0123456789abcdef01234567";

  it("passes for a commit in the repository, alone or after an @, and ignores non-commits", () => {
    const text = promptOf(
      `Commit ${head}.`,
      `Pinned at @${head},`,
      "Not hashes: deadbeef 1234567 abc123",
    );
    expect(failuresOf(text, realRootContext())).toEqual([]);
  });

  it("fails on the line holding a commit that no repository has", () => {
    const text = promptOf("fine", `Start at ${absentCommit}.`);
    expect(failuresOf(text, realRootContext())).toEqual([`commit:${bodyLine(1)}`]);
  });

  describe("a range", () => {
    const other = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334";

    it("passes when both ends are commits, or the end is HEAD", () => {
      const text = promptOf(`Diff ${head}..${head} and ${head}..HEAD.`);
      expect(failuresOf(text, realRootContext())).toEqual([]);
    });

    it("fails on the start end alone when only the start is not a commit", () => {
      const text = promptOf("fine", `Diff ${absentCommit}..HEAD.`);
      expect(failuresOf(text, realRootContext())).toEqual([`commit:${bodyLine(1)}`]);
      expect(messagesOf(text, realRootContext())[0]).toContain(absentCommit);
    });

    it("fails on the end alone when only the end is not a commit", () => {
      const text = promptOf("fine", `Diff ${head}..${absentCommit}.`);
      expect(failuresOf(text, realRootContext())).toEqual([`commit:${bodyLine(1)}`]);
      expect(messagesOf(text, realRootContext())[0]).toContain(absentCommit);
    });

    it("fails once for each end that is not a commit", () => {
      const text = promptOf("fine", `Diff ${absentCommit}..${other}.`);
      expect(failuresOf(text, realRootContext())).toEqual([
        `commit:${bodyLine(1)}`,
        `commit:${bodyLine(1)}`,
      ]);
    });

    it("leaves a token alone when an end has no commit shape", () => {
      const text = promptOf("Diff 1234567..HEAD and HEAD..deadbeef.");
      expect(failuresOf(text, realRootContext())).toEqual([]);
    });
  });

  describe("the token length", () => {
    const sevenChars = "0f1e2d3";
    const fortyChars = "0123456789abcdef0123456789abcdef01234567";

    it.each([
      { length: 6, token: sevenChars.slice(0, 6), isCommitToken: false },
      { length: 7, token: sevenChars, isCommitToken: true },
      { length: 40, token: fortyChars, isCommitToken: true },
      { length: 41, token: `${fortyChars}8`, isCommitToken: false },
    ])("treats a $length character hex token as a commit token: $isCommitToken", (row) => {
      const failures = failuresOf(promptOf("fine", `At ${row.token}.`), realRootContext());
      expect(failures).toEqual(row.isCommitToken ? [`commit:${bodyLine(1)}`] : []);
    });
  });

  describe("a commit that only the docs repository has", () => {
    const docsCommit = (): string | undefined => {
      try {
        const options = { encoding: "utf8", stdio: "pipe" } as const;
        const short = execFileSync("git", ["-C", "docs", "rev-parse", "--short", "HEAD"], options);
        const full = execFileSync("git", ["-C", "docs", "rev-parse", "HEAD"], options);
        const hasDigitAndLetter = /[0-9]/.test(short) && /[a-f]/.test(short);
        return (hasDigitAndLetter ? short : full).trim();
      } catch {
        return undefined;
      }
    };
    const id = docsCommit();
    if (id === undefined) console.log("skipped: docs/ is not a git repository here");

    it.skipIf(id === undefined)("passes", () => {
      expect(failuresOf(promptOf(`Docs at ${id}.`), realRootContext())).toEqual([]);
    });
  });

  describe("a sha256", () => {
    const content = "digest me\n";
    const digest = createHash("sha256").update(content).digest("hex");
    const files = { "notes/data.txt": content, "notes/more.txt": "more\n" };

    it("has a digest that holds a digit and a letter, so the checker reads it as a hash", () => {
      expect(digest).toMatch(/[0-9]/);
      expect(digest).toMatch(/[a-f]/);
    });

    it("passes when the one existing path on its line hashes to it", () => {
      withRoot(files, (context) => {
        expect(failuresOf(promptOf(`notes/data.txt has sha256 ${digest}`), context)).toEqual([]);
      });
    });

    it("fails when the file on its line hashes to something else", () => {
      withRoot(files, (context) => {
        const wrong = digest.replace(/^./, (first) => (first === "0" ? "1" : "0"));
        const text = promptOf("fine", `notes/data.txt has sha256 ${wrong}`);
        expect(failuresOf(text, context)).toEqual([`commit:${bodyLine(1)}`]);
        expect(messagesOf(text, context)).toEqual([
          "the sha256 is not the sha256 of notes/data.txt",
        ]);
      });
    });

    it.each([
      { name: "no path on its line", line: `sha256 ${digest}` },
      { name: "two existing paths on its line", line: `notes/data.txt notes/more.txt ${digest}` },
      { name: "only a missing path on its line", line: `notes/missing.txt ${digest}` },
    ])("fails as unclassifiable with $name", ({ line }) => {
      withRoot(files, (context) => {
        const failures = failuresOf(promptOf("fine", line), context);
        expect(failures).toContain(`commit:${bodyLine(1)}`);
        const messages = messagesOf(promptOf("fine", line), context);
        expect(messages.some((message) => message.includes("cannot be classified"))).toBe(true);
      });
    });
  });
});

describe("words", () => {
  const files = { "notes/open-debt.md": "ledger\n" };

  it("passes for the words inside a recorded block and inside a path token", () => {
    withRoot(files, (context) => {
      const text = promptOf(
        "BEGIN RECORDED WORDS",
        '"Accepted, ruled and decided." Debt.',
        "END RECORDED WORDS",
        "Read notes/open-debt.md and a undecided, unruled thing.",
      );
      expect(failuresOf(text, context)).toEqual([]);
    });
  });

  it.each([
    { word: "accepted", written: "Accepted" },
    { word: "decided", written: "decided" },
    { word: "ruled", written: "RULED" },
    { word: "debt", written: "debt" },
  ])("fails on the line holding $word outside a block, whatever its case", ({ word, written }) => {
    withRoot(files, (context) => {
      const text = promptOf("fine", `It was ${written} by someone.`);
      expect(failuresOf(text, context)).toEqual([`words:${bodyLine(1)}`]);
      expect(messagesOf(text, context)[0]).toContain(`"${word}"`);
    });
  });

  it("fails on the BEGIN line that has no END", () => {
    withRoot(files, (context) => {
      const text = promptOf("fine", "BEGIN RECORDED WORDS", "decided");
      expect(failuresOf(text, context)).toEqual([`words:${bodyLine(1)}`]);
    });
  });

  it("fails on an END line that has no BEGIN", () => {
    withRoot(files, (context) => {
      const text = promptOf("fine", "END RECORDED WORDS");
      expect(failuresOf(text, context)).toEqual([`words:${bodyLine(1)}`]);
      expect(messagesOf(text, context)).toEqual(["END RECORDED WORDS has no BEGIN RECORDED WORDS"]);
    });
  });

  it("fails on a BEGIN line while a block is open, and the outer block still closes", () => {
    withRoot(files, (context) => {
      const text = promptOf(
        "BEGIN RECORDED WORDS",
        "decided",
        "BEGIN RECORDED WORDS",
        "END RECORDED WORDS",
      );
      expect(failuresOf(text, context)).toEqual([`words:${bodyLine(2)}`]);
      expect(messagesOf(text, context)[0]).toContain("opened at line 4");
    });
  });

  it("fails on a word after the END line of an earlier block", () => {
    withRoot(files, (context) => {
      const text = promptOf("BEGIN RECORDED WORDS", "decided", "END RECORDED WORDS", "decided");
      expect(failuresOf(text, context)).toEqual([`words:${bodyLine(3)}`]);
    });
  });
});

describe("the report", () => {
  it("lists the findings in line order and counts them in the last line", () => {
    withRoot({}, (context) => {
      const text = [
        "Implementer: a",
        "Tier: 2",
        "Reviewers: b",
        `x${EM_DASH}y`,
        "It was decided.",
      ].join("\n");
      const lines = reportLinesOf(checkPromptText(text, context));
      expect(lines).toEqual([
        "FAIL dash line 4: holds U+2014",
        "FAIL end line 5: the last non-empty line must be exactly END OF PROMPT",
        'FAIL words line 5: "decided" outside a BEGIN RECORDED WORDS block',
        "check-prompt: 3 finding(s), templates: 0, unclassified: 0",
      ]);
    });
  });
});

describe("the command line", () => {
  const checker = (args: string[]) =>
    spawnSync("node", ["--import", "tsx", "scripts/lk/check-prompt.ts", ...args], {
      encoding: "utf8",
    });

  const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;
  const checkerPath = join(process.cwd(), "scripts/lk/check-prompt.ts");

  const checkerIn = (cwd: string, args: string[]) =>
    spawnSync("node", ["--import", tsxLoader, checkerPath, ...args], { cwd, encoding: "utf8" });

  /** A folder under the repository's own .work, because the checker refuses a prompt outside the cwd. */
  const withWorkFolder = <T>(body: (folder: string) => T): T => {
    const parent = join(process.cwd(), ".work");
    mkdirSync(parent, { recursive: true });
    const folder = mkdtempSync(join(parent, "lk-check-prompt-"));
    try {
      return body(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  const refusalExit = spawnSync(
    "node",
    ["--import", "tsx", "scripts/lk/models.ts", "--class", "Huge"],
    {
      encoding: "utf8",
    },
  ).status;

  const lastLineOf = (output: string): string => output.trimEnd().split("\n").pop() ?? "";

  const runOnPrompt = (text: string) =>
    withWorkFolder((folder) => {
      const path = join(folder, "prompt.md");
      writeFileSync(path, text);
      return checker([path]);
    });

  it("exits 0 and prints PASS for a clean prompt", () => {
    const result = runOnPrompt(promptOf("a clean line"));
    expect(result.status).toBe(0);
    expect(lastLineOf(result.stdout)).toBe("check-prompt: PASS, templates: 0, unclassified: 0");
  });

  it("exits 1 and counts the findings for a prompt with a defect", () => {
    const result = runOnPrompt([...HEAD_LINES, "body"].join("\n"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL end line 4: ");
    expect(lastLineOf(result.stdout)).toBe(
      "check-prompt: 1 finding(s), templates: 0, unclassified: 0",
    );
  });

  it("refuses a file that is missing, with the exit code of refuse from models", () => {
    const result = withWorkFolder((folder) => checker([join(folder, "absent.md")]));
    expect(refusalExit).toBe(1);
    expect(result.status).toBe(refusalExit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^LK REFUSED: cannot read the prompt at .*absent\.md\n$/);
  });

  it("refuses an empty file", () => {
    const result = runOnPrompt("\n  \n");
    expect(result.status).toBe(refusalExit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^LK REFUSED: the prompt at .* is empty\n$/);
  });

  it("refuses a prompt file that is outside the current directory", () => {
    const result = withWorkspace((folder) => {
      const path = join(folder, "prompt.md");
      writeFileSync(path, promptOf("a clean line"));
      return checker([path]);
    });
    expect(result.status).toBe(refusalExit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^LK REFUSED: the prompt at .*prompt\.md is not inside the current directory .*\n$/,
    );
  });

  it("refuses a run from a directory that holds no package.json, whatever the prompt holds", () => {
    const result = withWorkspace((folder) => {
      const directory = realpathSync(folder);
      const path = join(directory, "prompt.md");
      writeFileSync(path, promptOf("a clean line"));
      return checkerIn(directory, [path]);
    });
    expect(result.status).toBe(refusalExit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^LK REFUSED: the current directory .* holds no package\.json, so it is not the repository root\n$/,
    );
  });

  it("refuses when no file is given", () => {
    const result = checker([]);
    expect(result.status).toBe(refusalExit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("LK REFUSED: give the path of a prompt file\n");
  });
});
