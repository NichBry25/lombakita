// @vitest-environment node

/**
 * The session dispatcher.
 *
 * Command line cases run the real script against a temp repository root with a stand-in `claude`
 * first on PATH, so the exit codes, the files written and the arguments the session receives are
 * the ones a real dispatch produces. In-process cases hand `dispatchRun` injected seams for the
 * parts a command line cannot reach. No case starts a real `claude`.
 */

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeArgs,
  buildSmokeArgs,
  createRunSmoke,
  DENY_LIST,
  DENY_PATTERNS,
  dispatchRun,
  initWorkItem,
  isProcessAlive,
  readRunStatus,
  rmClusterPatterns,
  runSmokeWithClaude,
  SMOKE_TIMEOUT_SECONDS,
  spawnSessionWithClaude,
  type DispatchDeps,
  type RunOptions,
  type RunRecord,
  type SpawnSession,
} from "./dispatch";
import { LkRefusal, type Env } from "./models";

// The dispatcher's own calls to these are wrapped, not replaced, so a case can watch what the
// dispatcher hands them and make one fail once.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

const realChildProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const FIXTURES = join(process.cwd(), "scripts/testing/fixtures/lk");
const STANDARD_MODEL = "claude-test-standard";
const LIGHT_MODEL = "claude-test-light";
const VALID_PROMPT = "Write the result file.\n\nEND OF PROMPT\n";

const workspace = mkdtempSync(join(tmpdir(), "lk-dispatch-"));
const binDir = join(workspace, "bin");
mkdirSync(binDir);
copyFileSync(join(FIXTURES, "fake-claude.sh"), join(binDir, "claude"));
chmodSync(join(binDir, "claude"), 0o755);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  log: string;
  snapshot: string;
}

const makeSandbox = (): Sandbox => {
  const base = mkdtempSync(join(workspace, "sandbox-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "docs/project"), { recursive: true });
  copyFileSync(join(FIXTURES, "models.md"), join(root, "docs/project/models.md"));
  mkdirSync(join(root, ".work"));
  return { root, log: join(base, "calls.log"), snapshot: join(base, "run-snapshot.json") };
};

const addWorkItem = (sandbox: Sandbox, slug: string, prompt = VALID_PROMPT): string => {
  const folder = join(sandbox.root, ".work", slug);
  mkdirSync(folder);
  if (prompt !== "") writeFileSync(join(folder, "02-prompt.md"), prompt);
  return folder;
};

const dispatchEnv = (
  sandbox: Sandbox,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    LK_ROLE: "controller",
    FAKE_CLAUDE_LOG: sandbox.log,
    FAKE_RUN_SNAPSHOT: sandbox.snapshot,
  };
  delete env.LK_SLUG;
  delete env.FAKE_SMOKE;
  delete env.FAKE_SMOKE_TEXT;
  delete env.FAKE_MAIN_EXIT;
  delete env.FAKE_RELEASE_FILE;
  delete env.FAKE_SIGNAL_FILE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
};

const dispatchArgs = (sandbox: Sandbox, args: string[]): string[] => [
  "--import",
  "tsx",
  "scripts/lk/dispatch.ts",
  ...args,
  "--root",
  sandbox.root,
];

const dispatch = (
  sandbox: Sandbox,
  args: string[],
  overrides: Record<string, string | undefined> = {},
) =>
  spawnSync(process.execPath, dispatchArgs(sandbox, args), {
    encoding: "utf8",
    env: dispatchEnv(sandbox, overrides),
  });

const run = (
  sandbox: Sandbox,
  slug: string,
  extra: string[] = [],
  overrides: Record<string, string | undefined> = {},
) => dispatch(sandbox, ["run", slug, "--job", "implement", "--tier", "1", ...extra], overrides);

interface Call {
  args: string[];
  env: string;
  cwd: string;
}

const readCalls = (sandbox: Sandbox): Call[] => {
  if (!existsSync(sandbox.log)) return [];
  const calls: Call[] = [];
  for (const token of readFileSync(sandbox.log, "utf8").split("\0")) {
    const last = calls.at(-1);
    if (token === "CALL") calls.push({ args: [], env: "", cwd: "" });
    else if (token.startsWith("ARG ") && last !== undefined) last.args.push(token.slice(4));
    else if (token.startsWith("ENV ") && last !== undefined) last.env = token.slice(4);
    else if (token.startsWith("CWD ") && last !== undefined) last.cwd = token.slice(4);
  }
  return calls;
};

const readRecord = (sandbox: Sandbox, slug: string): RunRecord =>
  JSON.parse(readFileSync(join(sandbox.root, ".work", slug, "run.json"), "utf8")) as RunRecord;

const lockPath = (sandbox: Sandbox): string => join(sandbox.root, ".work/.lock");

const expectRefused = (
  result: ReturnType<typeof dispatch>,
  message: string | RegExp,
  sandbox: Sandbox,
  slug: string,
): void => {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^LK REFUSED: [^\n]+\n$/);
  if (typeof message === "string") expect(result.stderr).toContain(message);
  else expect(result.stderr).toMatch(message);
  expect(readCalls(sandbox)).toEqual([]);
  expect(existsSync(join(sandbox.root, ".work", slug, "run.json"))).toBe(false);
  expect(existsSync(join(sandbox.root, ".work", slug, "session.jsonl"))).toBe(false);
};

describe("the arguments a session receives", () => {
  it("are exactly the headless flags, the model and the deny list", () => {
    expect(buildClaudeArgs("the prompt", "claude-x")).toEqual([
      "-p",
      "the prompt",
      "--model",
      "claude-x",
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      DENY_LIST,
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("name the force, reset, clean, rm, sudo, gh, vercel, railway and db patterns", () => {
    const base = [
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git -C * push --force*)",
      "Bash(git -C * push -f*)",
      "Bash(git reset --hard*)",
      "Bash(git -C * reset --hard*)",
      "Bash(git clean*)",
      "Bash(git -C * clean*)",
      "Bash(rm -r*)",
      "Bash(sudo *)",
      "Bash(gh *)",
      "Bash(vercel *)",
      "Bash(railway *)",
      "Bash(npm run db:*)",
    ];
    for (const pattern of base) expect(DENY_PATTERNS).toContain(pattern);
  });

  it.each([
    ["a force flag after the remote", "Bash(git push * --force*)"],
    ["a short force flag after the remote", "Bash(git push * -f*)"],
    ["a plus refspec", "Bash(git push * +*)"],
    ["a force flag after the remote, with -C", "Bash(git -C * push * --force*)"],
    ["a short force flag after the remote, with -C", "Bash(git -C * push * -f*)"],
    ["a plus refspec, with -C", "Bash(git -C * push * +*)"],
    ["any push whose text holds main", "Bash(git push *main*)"],
    ["a push with no branch", "Bash(git push)"],
    ["a push to the remote with no branch", "Bash(git push origin)"],
    ["any push whose text holds main, with -C", "Bash(git -C * push *main*)"],
    ["a push with no branch, with -C", "Bash(git -C * push)"],
    ["a push to the remote with no branch, with -C", "Bash(git -C * push origin)"],
    ["rm with a capital R flag", "Bash(rm -R*)"],
    ["rm with --recursive", "Bash(rm --recursive*)"],
    ["rm with -r given as a separate flag", "Bash(rm * -r*)"],
    ["rm with -R given as a separate flag", "Bash(rm * -R*)"],
    ["rm with --recursive given as a separate flag", "Bash(rm * --recursive*)"],
    ["rm reached by an absolute path", "Bash(/*/rm *)"],
    ["git branch -D", "Bash(git branch -D*)"],
    ["git branch -D, with -C", "Bash(git -C * branch -D*)"],
    ["any git reached by an absolute path", "Bash(/*/git *)"],
    ["the Read tool on the topic folder", "Read(~/.config/lombakita/**)"],
    ["the Edit tool on the topic folder", "Edit(~/.config/lombakita/**)"],
    ["the Write tool on the topic folder", "Write(~/.config/lombakita/**)"],
    ["cat on the topic folder", "Bash(cat *.config/lombakita/*)"],
    ["head on the topic folder", "Bash(head *.config/lombakita/*)"],
    ["tail on the topic folder", "Bash(tail *.config/lombakita/*)"],
    ["less on the topic folder", "Bash(less *.config/lombakita/*)"],
    ["grep on the topic folder", "Bash(grep *.config/lombakita/*)"],
    ["a force flag before the remote, as rtk rewrites it", "Bash(rtk git push --force*)"],
    ["a short force flag before the remote, as rtk rewrites it", "Bash(rtk git push -f*)"],
    [
      "a force flag before the remote, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push --force*)",
    ],
    [
      "a short force flag before the remote, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push -f*)",
    ],
    ["a force flag after the remote, as rtk rewrites it", "Bash(rtk git push * --force*)"],
    ["a short force flag after the remote, as rtk rewrites it", "Bash(rtk git push * -f*)"],
    ["a plus refspec, as rtk rewrites it", "Bash(rtk git push * +*)"],
    [
      "a force flag after the remote, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push * --force*)",
    ],
    [
      "a short force flag after the remote, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push * -f*)",
    ],
    ["a plus refspec, with -C, as rtk rewrites it", "Bash(rtk git -C * push * +*)"],
    ["any push whose text holds main, as rtk rewrites it", "Bash(rtk git push *main*)"],
    ["a push with no branch, as rtk rewrites it", "Bash(rtk git push)"],
    ["a push to the remote with no branch, as rtk rewrites it", "Bash(rtk git push origin)"],
    [
      "any push whose text holds main, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push *main*)",
    ],
    ["a push with no branch, with -C, as rtk rewrites it", "Bash(rtk git -C * push)"],
    [
      "a push to the remote with no branch, with -C, as rtk rewrites it",
      "Bash(rtk git -C * push origin)",
    ],
    ["git branch -D, as rtk rewrites it", "Bash(rtk git branch -D*)"],
    ["git branch -D, with -C, as rtk rewrites it", "Bash(rtk git -C * branch -D*)"],
    [
      "cat and head on the topic folder, as rtk rewrites them",
      "Bash(rtk read *.config/lombakita/*)",
    ],
    ["grep on the topic folder, as rtk rewrites it", "Bash(rtk grep *.config/lombakita/*)"],
    ["gh, as rtk rewrites it", "Bash(rtk gh *)"],
    ["a db script, as rtk rewrites it", "Bash(rtk npm run db:*)"],
  ])("name %s", (_what, pattern) => {
    expect(DENY_PATTERNS).toContain(pattern);
  });

  it("are each named once, none with a comma, and 205 in all", () => {
    expect(DENY_PATTERNS).toHaveLength(205);
    expect(new Set(DENY_PATTERNS).size).toBe(DENY_PATTERNS.length);
    for (const pattern of DENY_PATTERNS) {
      expect(pattern).toMatch(/^(Bash|Read|Edit|Write)\(.+\)$/);
      expect(pattern).not.toContain(",");
    }
    expect(DENY_LIST.split(",")).toEqual([...DENY_PATTERNS]);
  });

  it("make the smoke call a one turn text question", () => {
    expect(buildSmokeArgs("claude-x")).toEqual([
      "-p",
      "reply with the single word ok",
      "--model",
      "claude-x",
      "--max-turns",
      "1",
      "--output-format",
      "text",
    ]);
  });
});

// Stands in for the permission matcher's reading of a Bash pattern: `*` is the only wildcard, a
// trailing ` *` also matches the bare command, and every other character is literal. A match here
// predicts the matcher; only a real session proves it (scripts/lk/deny-proof.ts).
const patternMatches = (pattern: string, command: string): boolean => {
  const body = pattern.replace(/^Bash\((.*)\)$/, "$1");
  const endsWithOptionalArguments = body.endsWith(" *");
  const core = endsWithOptionalArguments ? body.slice(0, -2) : body;
  const source = core
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${endsWithOptionalArguments ? "( .*)?" : ""}$`).test(command);
};

const patternsDenying = (command: string): string[] =>
  DENY_PATTERNS.filter((pattern) => patternMatches(pattern, command));

describe("the rm flag clusters", () => {
  const LETTERS = ["f", "v", "i", "r", "R"];

  const everyClusterWithAnR = (): string[] => {
    const one = LETTERS;
    const two = one.flatMap((first) => LETTERS.map((second) => `${first}${second}`));
    const three = two.flatMap((pair) => LETTERS.map((third) => `${pair}${third}`));
    return [...one, ...two, ...three].filter((cluster) => /[rR]/.test(cluster));
  };

  it("are generated as 24 clusters, each as the first flag and as a later flag", () => {
    const patterns = rmClusterPatterns();
    expect(patterns).toHaveLength(48);
    expect(new Set(patterns).size).toBe(48);
    expect(patterns).toContain("Bash(rm -fr*)");
    expect(patterns).toContain("Bash(rm * -fr*)");
    expect(patterns).toContain("Bash(rm -vfR*)");
    expect(patterns).toContain("Bash(rm * -iiR*)");
    expect(patterns).not.toContain("Bash(rm -r*)");
    expect(patterns).not.toContain("Bash(rm -R*)");
  });

  it("are all in the deny list", () => {
    for (const pattern of rmClusterPatterns()) expect(DENY_PATTERNS).toContain(pattern);
  });

  it("leave no cluster of one to three of f, v, i, r and R that holds an r or R uncovered", () => {
    const clusters = everyClusterWithAnR();
    expect(clusters).toHaveLength(116);
    for (const cluster of clusters) {
      expect(patternsDenying(`rm -${cluster} victim`), `rm -${cluster} victim`).not.toEqual([]);
      expect(patternsDenying(`rm victim -${cluster}`), `rm victim -${cluster}`).not.toEqual([]);
    }
  });

  it("let through a cluster with no r or R and a file name that merely holds -r", () => {
    for (const command of [
      "rm -f keep.txt",
      "rm -v keep.txt",
      "rm -fvi keep.txt",
      "rm -f keep-report.txt",
    ]) {
      expect(patternsDenying(command), command).toEqual([]);
    }
  });
});

describe("the commands the deny list names", () => {
  it.each([
    ["git push -u origin HEAD", "rtk git push -u origin HEAD"],
    ["git push origin HEAD", "rtk git push origin HEAD"],
    ["git push HEAD", "rtk git push HEAD"],
    ["git push --all", "rtk git push --all"],
    ["git push --all origin", "rtk git push --all origin"],
    ["git push --mirror origin", "rtk git push --mirror origin"],
    ["git push --delete origin feature", "rtk git push --delete origin feature"],
    ["git push -d origin feature", "rtk git push -d origin feature"],
    ["git push origin :feature", "rtk git push origin :feature"],
    ["git push --prune origin", "rtk git push --prune origin"],
    ["git push -u", "rtk git push -u"],
    ["git push -u origin", "rtk git push -u origin"],
    ["git -C /tmp/x push -u origin HEAD", "rtk git -C /tmp/x push -u origin HEAD"],
    ["git -C /tmp/x push --all", "rtk git -C /tmp/x push --all"],
    ["git -C /tmp/x push origin :feature", "rtk git -C /tmp/x push origin :feature"],
    ["/usr/bin/git push --force origin feature", "/usr/bin/git push --force origin feature"],
    ["/usr/bin/git push origin feature", "/usr/bin/git push origin feature"],
    ["/usr/bin/git -C /tmp/x push origin feature", "/usr/bin/git -C /tmp/x push origin feature"],
    ["git branch --delete --force feature-two", "rtk git branch --delete --force feature-two"],
    ["git branch --force --delete feature-two", "rtk git branch --force --delete feature-two"],
    ["git branch -d -f feature-two", "rtk git branch -d -f feature-two"],
    ["git branch -f -d feature-two", "rtk git branch -f -d feature-two"],
    ["git branch -df feature-two", "rtk git branch -df feature-two"],
    ["git branch -f feature-two main", "rtk git branch -f feature-two main"],
    ["git -C /tmp/x branch --delete --force b", "rtk git -C /tmp/x branch --delete --force b"],
    ["gh pr merge 1", "rtk gh pr merge 1"],
    ["npm run db:reset", "rtk npm run db:reset"],
  ])("deny %s and the text rtk rewrites it to", (command, rewritten) => {
    expect(patternsDenying(command), command).not.toEqual([]);
    expect(patternsDenying(rewritten), rewritten).not.toEqual([]);
  });

  it.each([
    "rm -vfr victim",
    "rm -fvr victim",
    "rm -ir victim",
    "rm -vR victim",
    "rm victim -vfr",
    "rm -f -vr victim",
    "git restore -- .",
    "git restore .",
    "git restore --worktree .",
    "git restore -W .",
    "git restore --staged --worktree .",
    "git restore --source=HEAD~1 .",
    "git restore -s HEAD~1 .",
    "git -C /tmp/x restore -- .",
    "git checkout .",
    "git checkout -- .",
    "git checkout HEAD -- .",
    "git checkout -f",
    "git checkout -f feature",
    "git checkout feature -f",
    "git checkout --force",
    "git -C /tmp/x checkout -f",
  ])("deny %s", (command) => {
    expect(patternsDenying(command), command).not.toEqual([]);
  });

  it.each([
    "git push origin feature",
    "git push -u origin feature",
    "git push origin feature-fix",
    "git push origin feature-draft",
    "git -C /tmp/x push origin feature",
    "git checkout feature",
    "git checkout -b feature-three",
    "git restore .gitignore",
    "git restore --staged keep.txt",
    "git restore keep.txt",
    "git checkout .github/x",
    "git checkout -- .gitignore",
    "git branch feature-three",
    "git branch -d feature-two",
    "git -C /tmp/x branch --list",
    "rm keep.txt",
    "rm -f keep.txt",
    "rm -v keep.txt",
    "rm -f keep-report.txt",
  ])("let %s through", (command) => {
    expect(patternsDenying(command), command).toEqual([]);
    expect(patternsDenying(`rtk ${command}`), `rtk ${command}`).toEqual([]);
  });
});

describe("refusals, each before anything is started", () => {
  it.each([undefined, "implementer", "Controller", ""])("refuses when LK_ROLE is %j", (role) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { LK_ROLE: role });
    expectRefused(result, 'LK_ROLE must be "controller" to dispatch', sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("names the role before any other fault", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "Bad_Slug", [], { LK_ROLE: undefined });
    expect(result.stderr).toBe('LK REFUSED: LK_ROLE must be "controller" to dispatch\n');
  });

  it("refuses a slug outside the pattern even when its folder and prompt exist", () => {
    const sandbox = makeSandbox();
    for (const slug of ["Bad_Slug", "step-2", "trail-", "double--dash"]) {
      addWorkItem(sandbox, slug);
      const result = run(sandbox, slug);
      expectRefused(result, `slug "${slug}" does not match`, sandbox, slug);
    }
  });

  it("refuses a slug that climbs out of .work", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "../escape");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match");
  });

  it("refuses a work item with no folder", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "ghost");
    expectRefused(result, /no work folder .*\.work\/ghost\n$/, sandbox, "ghost");
  });

  it.each([
    { name: "a missing prompt file", prompt: "", message: "02-prompt.md is missing or empty" },
    { name: "an empty prompt file", prompt: " \n\n", message: "02-prompt.md is missing or empty" },
    {
      name: "a prompt with no end marker",
      prompt: "Do the thing.\n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a prompt cut before the marker",
      prompt: "Do the thing.\nEND OF PRO",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker with trailing text",
      prompt: "Do it.\nEND OF PROMPT.\n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker followed by more text",
      prompt: "END OF PROMPT\nmore\n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker with trailing spaces",
      prompt: "Do it.\nEND OF PROMPT  \n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker with leading spaces",
      prompt: "Do it.\n  END OF PROMPT\n",
      message: "does not end with the line END OF PROMPT",
    },
  ])("refuses $name", ({ prompt, message }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha", prompt);
    const result = run(sandbox, "alpha");
    expectRefused(result, message, sandbox, "alpha");
  });

  it("accepts blank lines after the marker", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha", "Do it.\n\nEND OF PROMPT\n\n\n");
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(0);
  });

  it.each([
    {
      name: "a job and tier with no row",
      args: ["--job", "review", "--tier", "2"],
      message: "no class for job review tier 2",
    },
    {
      name: "an unknown job",
      args: ["--job", "deploy", "--tier", "1"],
      message: "no class for job deploy tier 1",
    },
    {
      name: "tier any as a request",
      args: ["--job", "lookup", "--tier", "any"],
      message: 'tier must be 1, 2 or 3, not "any"',
    },
    {
      name: "a tier of 4",
      args: ["--job", "lookup", "--tier", "4"],
      message: 'tier must be 1, 2 or 3, not "4"',
    },
  ])("refuses $name", ({ args, message }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = dispatch(sandbox, ["run", "alpha", ...args]);
    expectRefused(result, message, sandbox, "alpha");
  });

  it("refuses when the model table cannot be read or is damaged", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const table = join(sandbox.root, "docs/project/models.md");
    writeFileSync(table, readFileSync(table, "utf8").replace("claude-test-standard", "NotAModel"));
    expectRefused(run(sandbox, "alpha"), "is not a model id", sandbox, "alpha");
    rmSync(table);
    expectRefused(run(sandbox, "alpha"), "cannot read the model table", sandbox, "alpha");
  });

  it("refuses an override that is not a model id", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--model", "Not A Model"]);
    expectRefused(result, '--model "Not A Model" is not a model id', sandbox, "alpha");
  });

  it("refuses an extra argument after the slug without starting anything", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = dispatch(sandbox, [
      "run",
      "alpha",
      "extra",
      "--job",
      "implement",
      "--tier",
      "1",
    ]);
    expectRefused(result, 'unexpected argument "extra"', sandbox, "alpha");
  });

  it("refuses a missing --job or --tier and an unknown command", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    expect(dispatch(sandbox, ["run", "alpha", "--job", "implement"]).stderr).toContain(
      "run needs --job and --tier",
    );
    expect(dispatch(sandbox, ["launch", "alpha"]).stderr).toContain("usage:");
  });
});

describe("the lock", () => {
  it("refuses while a live process holds it and leaves it untouched", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const holder = JSON.stringify({ pid: process.pid, slug: "beta" });
    writeFileSync(lockPath(sandbox), holder);
    const result = run(sandbox, "alpha");
    expectRefused(result, `slug beta holds the lock (pid ${process.pid})`, sandbox, "alpha");
    expect(readFileSync(lockPath(sandbox), "utf8")).toBe(holder);
  });

  it("removes a lock whose process is gone, says so and carries on", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const deadPid = spawnSync("node", ["-e", ""]).pid;
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: deadPid, slug: "old" }));
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LK NOTE: stale lock removed\n");
    expect(readRecord(sandbox, "alpha").status).toBe("done");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses a lock file it cannot read rather than guess it is stale", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), "not json");
    const result = run(sandbox, "alpha");
    expectRefused(result, "is unreadable", sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(true);
  });
});

describe("the smoke call", () => {
  it.each(["silent", "fail", "okfail", "broken"])(
    "refuses when the model answers in mode %s",
    (mode) => {
      const sandbox = makeSandbox();
      addWorkItem(sandbox, "alpha");
      const result = run(sandbox, "alpha", [], { FAKE_SMOKE: mode });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`LK REFUSED: model ${STANDARD_MODEL} did not answer\n`);
      const calls = readCalls(sandbox);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(buildSmokeArgs(STANDARD_MODEL));
      expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
      expect(existsSync(join(sandbox.root, ".work/alpha/session.jsonl"))).toBe(false);
      expect(existsSync(lockPath(sandbox))).toBe(false);
    },
  );

  it("asks the model that will run, as an implementer so the controller hooks stay quiet", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    const [smoke] = readCalls(sandbox);
    expect(smoke?.args).toEqual(buildSmokeArgs(STANDARD_MODEL));
    expect(smoke?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha");
  });

  it.each([
    { answer: "ok", accepted: true },
    { answer: "Nicholas, ok.", accepted: true },
    { answer: "OK!", accepted: true },
    { answer: "the token is broken", accepted: false },
    { answer: "book", accepted: false },
    { answer: "okay", accepted: false },
  ])("takes the answer $answer as accepted: $accepted", ({ answer, accepted }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { FAKE_SMOKE: "text", FAKE_SMOKE_TEXT: answer });
    expect(result.status).toBe(accepted ? 0 : 1);
    if (!accepted)
      expect(result.stderr).toBe(`LK REFUSED: model ${STANDARD_MODEL} did not answer\n`);
  });

  it("asks from the repository root", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    const [smoke, session] = readCalls(sandbox);
    expect(realpathSync(smoke?.cwd ?? "")).toBe(realpathSync(sandbox.root));
    expect(realpathSync(session?.cwd ?? "")).toBe(realpathSync(sandbox.root));
  });

  it("is skipped by --no-smoke", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--no-smoke"], { FAKE_SMOKE: "fail" });
    expect(result.status).toBe(0);
    expect(readCalls(sandbox)).toHaveLength(1);
  });
});

describe("--dry-run", () => {
  it("prints the class, model and arguments with the prompt replaced by its length, and writes nothing", () => {
    const sandbox = makeSandbox();
    const folder = addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--dry-run"], { FAKE_SMOKE: "fail" });
    expect(result.status).toBe(0);
    const [head, args] = result.stdout.trimEnd().split("\n");
    expect(head).toBe(
      `LK DRY-RUN alpha job=implement tier=1 class=Standard model=${STANDARD_MODEL} override=false`,
    );
    expect(args).toBe(
      `args: ${JSON.stringify(buildClaudeArgs(`<${VALID_PROMPT.length} characters>`, STANDARD_MODEL))}`,
    );
    expect(readCalls(sandbox)).toEqual([]);
    expect(readdirSync(folder)).toEqual(["02-prompt.md"]);
    expect(readdirSync(join(sandbox.root, ".work"))).toEqual(["alpha"]);
  });

  it("leaves a stale lock in place and says it is there", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const stale = JSON.stringify({ pid: spawnSync("node", ["-e", ""]).pid, slug: "old" });
    writeFileSync(lockPath(sandbox), stale);
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LK NOTE: stale lock present, a real run removes it");
    expect(readFileSync(lockPath(sandbox), "utf8")).toBe(stale);
  });

  it("still refuses a live lock", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: process.pid, slug: "beta" }));
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("slug beta holds the lock");
  });
});

describe("a real run", () => {
  it("passes the session exactly the built arguments, as an implementer, from the repository root", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("LK DISPATCH alpha done exit 0\n");
    const [, session] = readCalls(sandbox);
    expect(session?.args).toEqual(buildClaudeArgs(VALID_PROMPT, STANDARD_MODEL));
    expect(session?.args).toContain(DENY_LIST);
    expect(session?.args).toContain("bypassPermissions");
    expect(session?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha");
  });

  it("records running while the session runs and done with exit 0 afterwards", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    const during = JSON.parse(readFileSync(sandbox.snapshot, "utf8")) as RunRecord;
    expect(during.status).toBe("running");
    expect(during.exit).toBeUndefined();
    expect(readFileSync(`${sandbox.snapshot}.lock`, "utf8")).toBe("present\n");

    const after = readRecord(sandbox, "alpha");
    expect(after).toMatchObject({
      slug: "alpha",
      job: "implement",
      tier: "1",
      class: "Standard",
      model: STANDARD_MODEL,
      override: false,
      status: "done",
      exit: 0,
    });
    expect(Number.isInteger(after.pid)).toBe(true);
    expect(new Date(after.started).toISOString()).toBe(after.started);
    expect(new Date(after.ended ?? "").toISOString()).toBe(after.ended);
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("appends the session's output and error text to session.jsonl", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    expect(readFileSync(join(sandbox.root, ".work/alpha/session.jsonl"), "utf8")).toBe(
      'stderr from the session\n{"type":"result"}\n',
    );
  });

  it("keeps what an earlier run left in session.jsonl", () => {
    const sandbox = makeSandbox();
    const folder = addWorkItem(sandbox, "alpha");
    writeFileSync(join(folder, "session.jsonl"), "earlier line\n");
    run(sandbox, "alpha");
    expect(readFileSync(join(folder, "session.jsonl"), "utf8")).toBe(
      'earlier line\nstderr from the session\n{"type":"result"}\n',
    );
  });

  it("records failed with the session's exit code, exits with it and still removes the lock", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { FAKE_MAIN_EXIT: "3" });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("LK DISPATCH alpha failed exit 3\n");
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 3 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("records failed with exit 127 when claude cannot be started", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--no-smoke"], { PATH: "/nonexistent" });
    expect(result.status).toBe(127);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 127 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("replaces only the model name with --model and records the override", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha", ["--model", "claude-test-other"]);
    const [smoke, session] = readCalls(sandbox);
    expect(smoke?.args).toEqual(buildSmokeArgs("claude-test-other"));
    expect(session?.args).toEqual(buildClaudeArgs(VALID_PROMPT, "claude-test-other"));
    expect(readRecord(sandbox, "alpha")).toMatchObject({
      class: "Standard",
      model: "claude-test-other",
      override: true,
    });
  });

  it("takes the exact tier row over the any row, and the any row when no exact row exists", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    dispatch(sandbox, ["run", "alpha", "--job", "implement", "--tier", "3", "--no-smoke"]);
    dispatch(sandbox, ["run", "beta", "--job", "implement", "--tier", "2", "--no-smoke"]);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ class: "Light", model: LIGHT_MODEL });
    expect(readRecord(sandbox, "beta")).toMatchObject({ class: "Standard", model: STANDARD_MODEL });
  });
});

describe("a session that is still running", () => {
  interface LockFile {
    pid: number;
    slug: string;
    childPid?: number;
  }

  const startDispatch = (
    sandbox: Sandbox,
    slug: string,
    releaseFile: string,
    extraEnv: Record<string, string> = {},
  ) => {
    const child = spawn(
      process.execPath,
      dispatchArgs(sandbox, ["run", slug, "--job", "implement", "--tier", "1", "--no-smoke"]),
      {
        env: dispatchEnv(sandbox, { FAKE_RELEASE_FILE: releaseFile, ...extraEnv }),
        stdio: "ignore",
      },
    );
    const exited = new Promise<{ code: number | null }>((resolveExit) => {
      child.on("exit", (code) => resolveExit({ code }));
    });
    return { child, exited };
  };

  const readLockFile = (sandbox: Sandbox): LockFile | undefined => {
    try {
      return JSON.parse(readFileSync(lockPath(sandbox), "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  };

  const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const lockedChildPid = async (sandbox: Sandbox): Promise<number> => {
    await waitFor(
      () => typeof readLockFile(sandbox)?.childPid === "number",
      "the session pid in the lock",
    );
    return readLockFile(sandbox)?.childPid ?? -1;
  };

  it("writes a lock naming the dispatcher and its session, and a second dispatch refuses against it", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const release = `${sandbox.log}.release`;
    const first = startDispatch(sandbox, "alpha", release);
    try {
      const childPid = await lockedChildPid(sandbox);
      expect(readLockFile(sandbox)).toEqual({ pid: first.child.pid, slug: "alpha", childPid });
      expect(childPid).not.toBe(first.child.pid);
      expect(isAlive(childPid)).toBe(true);

      const second = run(sandbox, "beta", ["--no-smoke"]);
      expect(second.status).toBe(1);
      expect(second.stderr).toBe(
        `LK REFUSED: slug alpha holds the lock (pid ${first.child.pid})\n`,
      );
      expect(existsSync(join(sandbox.root, ".work/beta/run.json"))).toBe(false);
    } finally {
      writeFileSync(release, "");
    }
    expect((await first.exited).code).toBe(0);
    expect(readRecord(sandbox, "alpha").status).toBe("done");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it.each([
    { signal: "SIGINT" as NodeJS.Signals, exitCode: 130 },
    { signal: "SIGTERM" as NodeJS.Signals, exitCode: 143 },
    { signal: "SIGHUP" as NodeJS.Signals, exitCode: 129 },
  ])(
    "passes $signal to the session as itself, waits for it, then records failed with exit $exitCode and the signal",
    async ({ signal, exitCode }) => {
      const sandbox = makeSandbox();
      addWorkItem(sandbox, "alpha");
      const release = `${sandbox.log}.release`;
      const received = `${sandbox.log}.signals`;
      const first = startDispatch(sandbox, "alpha", release, { FAKE_SIGNAL_FILE: received });
      try {
        const childPid = await lockedChildPid(sandbox);
        await waitFor(() => existsSync(`${sandbox.snapshot}.ready`), "the session to be waiting");
        first.child.kill(signal);
        expect((await first.exited).code).toBe(exitCode);
        expect(isAlive(childPid)).toBe(false);
      } finally {
        writeFileSync(release, "");
      }
      expect(readFileSync(received, "utf8")).toBe(`${signal}\n`);
      expect(readRecord(sandbox, "alpha")).toMatchObject({
        status: "failed",
        exit: exitCode,
        signal,
      });
      expect(existsSync(lockPath(sandbox))).toBe(false);
    },
  );

  it("keeps refusing after the dispatcher is killed outright while its session lives, and stops when the session ends", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const release = `${sandbox.log}.release`;
    const first = startDispatch(sandbox, "alpha", release);
    try {
      const childPid = await lockedChildPid(sandbox);
      first.child.kill("SIGKILL");
      await first.exited;
      const refused = run(sandbox, "beta", ["--dry-run"]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toBe(`LK REFUSED: slug alpha holds the lock (pid ${childPid})\n`);

      writeFileSync(release, "");
      await waitFor(() => !isAlive(childPid), "the session to end");
      const allowed = run(sandbox, "beta", ["--dry-run"]);
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toContain("LK NOTE: stale lock present");
    } finally {
      writeFileSync(release, "");
    }
  });
});

describe("init and status", () => {
  it("creates the work folder, prints its path and refuses to create it twice", () => {
    const sandbox = makeSandbox();
    const first = dispatch(sandbox, ["init", "alpha"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(`${join(sandbox.root, ".work/alpha")}\n`);
    expect(existsSync(join(sandbox.root, ".work/alpha"))).toBe(true);
    const second = dispatch(sandbox, ["init", "alpha"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/^LK REFUSED: .*alpha already exists\n$/);
  });

  it("refuses an invalid slug and creates nothing", () => {
    const sandbox = makeSandbox();
    for (const slug of ["Bad_Slug", "pilot-2", "../up"]) {
      const result = dispatch(sandbox, ["init", slug]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not match");
    }
    expect(readdirSync(join(sandbox.root, ".work"))).toEqual([]);
  });

  it("creates the .work folder when the repository has none", () => {
    const sandbox = makeSandbox();
    rmSync(join(sandbox.root, ".work"), { recursive: true });
    expect(dispatch(sandbox, ["init", "alpha"]).status).toBe(0);
    expect(existsSync(join(sandbox.root, ".work/alpha"))).toBe(true);
  });

  it("reports no run, then the run record", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    expect(dispatch(sandbox, ["status", "alpha"]).stdout).toBe("no run\n");
    run(sandbox, "alpha");
    const status = JSON.parse(dispatch(sandbox, ["status", "alpha"]).stdout) as RunRecord;
    expect(status).toMatchObject({ slug: "alpha", status: "done", exit: 0 });
    expect(dispatch(sandbox, ["status", "Bad_Slug"]).status).toBe(1);
  });
});

describe("dispatchRun with injected seams", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: false,
    dryRun: false,
  };
  const controllerEnv = { LK_ROLE: "controller", KEEP: "yes" };

  const seams = (overrides: Partial<DispatchDeps> = {}) => {
    const printed: string[] = [];
    const sessions: { args: string[]; cwd: string; env: Env; logPath: string }[] = [];
    const smokes: { model: string; env: Env }[] = [];
    const deps: DispatchDeps = {
      spawnSession: async (args, { cwd, env, logPath }) => {
        sessions.push({ args, cwd, env, logPath });
        return { exitCode: 5 };
      },
      runSmoke: (model, smokeOptions) => {
        smokes.push({ model, env: smokeOptions.env });
        return { status: 0, stdout: "ok", timedOut: false };
      },
      isProcessAlive: () => true,
      pid: 4242,
      print: (line) => printed.push(line),
      ...overrides,
    };
    return { deps, printed, sessions, smokes };
  };

  it("hands the session its arguments, working directory, log path and role without starting a process", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps, printed, sessions, smokes } = seams();
    const code = await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(code).toBe(5);
    expect(printed).toEqual(["LK DISPATCH alpha failed exit 5"]);
    expect(sessions).toEqual([
      {
        args: buildClaudeArgs(VALID_PROMPT, STANDARD_MODEL),
        cwd: sandbox.root,
        env: { LK_ROLE: "implementer", LK_SLUG: "alpha", KEEP: "yes" },
        logPath: join(sandbox.root, ".work/alpha/session.jsonl"),
      },
    ]);
    expect(smokes).toEqual([
      { model: STANDARD_MODEL, env: { LK_ROLE: "implementer", LK_SLUG: "alpha", KEEP: "yes" } },
    ]);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 5, pid: 4242 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses to start when another dispatch takes the lock during the smoke call", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps, sessions } = seams({
      runSmoke: () => {
        writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 1, slug: "rival" }));
        return { status: 0, stdout: "ok", timedOut: false };
      },
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      new LkRefusal("slug rival holds the lock"),
    );
    expect(sessions).toEqual([]);
    expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
    expect(readFileSync(lockPath(sandbox), "utf8")).toContain("rival");
  });

  it("removes the lock and records failed when the session cannot be started", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps } = seams({
      spawnSession: async () => {
        throw new Error("spawn exploded");
      },
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      "spawn exploded",
    );
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 1 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("removes a stale lock before it starts and prints the note first", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 99, slug: "old" }));
    const { deps, printed } = seams({ isProcessAlive: () => false });
    await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(printed[0]).toBe("LK NOTE: stale lock removed");
  });

  it("records the session pid in the lock as soon as the session exists", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    let lockWhileRunning: unknown;
    const { deps } = seams({
      spawnSession: async (_args, { onSpawn }) => {
        onSpawn(777);
        lockWhileRunning = JSON.parse(readFileSync(lockPath(sandbox), "utf8"));
        return { exitCode: 0 };
      },
    });
    await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(lockWhileRunning).toEqual({ pid: 4242, slug: "alpha", childPid: 777 });
  });

  it("treats a lock as held while either the dispatcher or its session is alive", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 4, slug: "old", childPid: 5 }));
    const sessionOnly = seams({ isProcessAlive: (pid) => pid === 5 });
    await expect(
      dispatchRun(options, sandbox.root, controllerEnv, sessionOnly.deps),
    ).rejects.toThrow(new LkRefusal("slug old holds the lock (pid 5)"));

    const neither = seams({ isProcessAlive: () => false });
    await dispatchRun(options, sandbox.root, controllerEnv, neither.deps);
    expect(neither.printed[0]).toBe("LK NOTE: stale lock removed");
  });

  it("refuses a lock whose session pid is not a number", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 4, slug: "old", childPid: "5" }));
    const { deps } = seams({ isProcessAlive: () => false });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      "is unreadable",
    );
  });

  it("refuses without the controller role before reading anything", async () => {
    const sandbox = makeSandbox();
    const { deps, sessions, smokes } = seams();
    await expect(
      dispatchRun(options, sandbox.root, { LK_ROLE: "implementer" }, deps),
    ).rejects.toThrow('LK_ROLE must be "controller" to dispatch');
    expect(sessions).toEqual([]);
    expect(smokes).toEqual([]);
  });

  it("initWorkItem and readRunStatus work on the root they are given", () => {
    const sandbox = makeSandbox();
    expect(initWorkItem(sandbox.root, "alpha")).toBe(join(sandbox.root, ".work/alpha"));
    expect(readRunStatus(sandbox.root, "alpha")).toBe("no run");
  });
});

describe("how the lock is written", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: true,
    dryRun: false,
  };
  const controllerEnv = { LK_ROLE: "controller" };

  const deps = (overrides: Partial<DispatchDeps> = {}): DispatchDeps => ({
    spawnSession: async (_args, { onSpawn }) => {
      onSpawn(777);
      return { exitCode: 0 };
    },
    runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
    isProcessAlive: () => false,
    pid: 4242,
    print: () => undefined,
    ...overrides,
  });

  const temporaryFiles = (sandbox: Sandbox): string[] =>
    readdirSync(join(sandbox.root, ".work")).filter((name) => name.endsWith(".tmp"));

  it("publishes a finished file with link, so the lock never exists part written", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    vi.mocked(linkSync).mockClear();
    let seen:
      | { source: string; target: string; content: string; targetExisted: boolean }
      | undefined;
    vi.mocked(linkSync).mockImplementationOnce((source, target) => {
      seen = {
        source: String(source),
        target: String(target),
        content: readFileSync(source, "utf8"),
        targetExisted: existsSync(target),
      };
      return realFs.linkSync(source, target);
    });
    await dispatchRun(options, sandbox.root, controllerEnv, deps());
    expect(seen).toEqual({
      source: join(sandbox.root, ".work/.lock.4242.tmp"),
      target: lockPath(sandbox),
      content: JSON.stringify({ pid: 4242, slug: "alpha" }),
      targetExisted: false,
    });
    expect(temporaryFiles(sandbox)).toEqual([]);
  });

  it("publishes the session pid with rename, so a reader sees the old lock or the new one", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    vi.mocked(renameSync).mockClear();
    let seen: { source: string; target: string; content: string; before: string } | undefined;
    vi.mocked(renameSync).mockImplementationOnce((source, target) => {
      seen = {
        source: String(source),
        target: String(target),
        content: readFileSync(source, "utf8"),
        before: readFileSync(target, "utf8"),
      };
      return realFs.renameSync(source, target);
    });
    let inodeBefore = 0;
    let inodeAfter = 0;
    await dispatchRun(
      options,
      sandbox.root,
      controllerEnv,
      deps({
        spawnSession: async (_args, { onSpawn }) => {
          inodeBefore = statSync(lockPath(sandbox)).ino;
          onSpawn(777);
          inodeAfter = statSync(lockPath(sandbox)).ino;
          return { exitCode: 0 };
        },
      }),
    );
    expect(seen).toEqual({
      source: join(sandbox.root, ".work/.lock.4242.tmp"),
      target: lockPath(sandbox),
      content: JSON.stringify({ pid: 4242, slug: "alpha", childPid: 777 }),
      before: JSON.stringify({ pid: 4242, slug: "alpha" }),
    });
    expect(inodeAfter).not.toBe(inodeBefore);
    expect(temporaryFiles(sandbox)).toEqual([]);
  });

  it("removes its temporary file when the lock is already taken", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const rivalTakesTheLock = deps({
      runSmoke: () => {
        writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 1, slug: "rival" }));
        return { status: 0, stdout: "ok", timedOut: false };
      },
    });
    await expect(
      dispatchRun({ ...options, noSmoke: false }, sandbox.root, controllerEnv, rivalTakesTheLock),
    ).rejects.toThrow(new LkRefusal("slug rival holds the lock"));
    expect(temporaryFiles(sandbox)).toEqual([]);
    expect(readFileSync(lockPath(sandbox), "utf8")).toContain("rival");
  });

  it("removes its temporary file when the rename fails", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps())).rejects.toThrow(
      "disk full",
    );
    expect(temporaryFiles(sandbox)).toEqual([]);
    expect(existsSync(lockPath(sandbox))).toBe(false);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 1 });
  });

  it("does not crash when another dispatcher removes the stale lock first", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 99, slug: "old" }));
    const code = await dispatchRun(
      options,
      sandbox.root,
      controllerEnv,
      deps({
        isProcessAlive: () => {
          rmSync(lockPath(sandbox), { force: true });
          return false;
        },
      }),
    );
    expect(code).toBe(0);
  });
});

describe("a run left behind by a dispatcher that died", () => {
  const KEPT_FIELDS = {
    slug: "old",
    job: "implement",
    tier: "2",
    class: "Standard",
    model: STANDARD_MODEL,
    override: true,
    started: "2026-10-19T01:00:00.000Z",
    pid: 31337,
  };
  const RUNNING = { ...KEPT_FIELDS, status: "running" };

  const leaveRunBehind = (sandbox: Sandbox, record: Record<string, unknown> = RUNNING): string => {
    const folder = addWorkItem(sandbox, "old");
    writeFileSync(join(folder, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    const deadPid = spawnSync("node", ["-e", ""]).pid;
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: deadPid, slug: "old" }));
    return join(folder, "run.json");
  };

  it("is rewritten as failed and lost by the next real run, keeping every other field", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const runPath = leaveRunBehind(sandbox);
    const result = run(sandbox, "alpha", ["--no-smoke"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LK NOTE: stale lock removed\n");
    expect(result.stdout).toContain("LK NOTE: run old was left running and is marked lost\n");
    const after = JSON.parse(readFileSync(runPath, "utf8")) as RunRecord;
    const { status, lost, ended, ...kept } = after;
    expect({ status, lost }).toEqual({ status: "failed", lost: true });
    expect(new Date(ended ?? "").toISOString()).toBe(ended);
    expect(kept).toEqual(KEPT_FIELDS);
    expect(after.exit).toBeUndefined();
  });

  it("is left alone when its record does not say running", () => {
    for (const status of ["done", "failed"]) {
      const sandbox = makeSandbox();
      addWorkItem(sandbox, "alpha");
      const record = { ...RUNNING, status, exit: 3, ended: "2026-10-19T02:00:00.000Z" };
      const runPath = leaveRunBehind(sandbox, record);
      const before = readFileSync(runPath, "utf8");
      const result = run(sandbox, "alpha", ["--no-smoke"]);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("marked lost");
      expect(readFileSync(runPath, "utf8")).toBe(before);
    }
  });

  it("is left alone by a dry run, which removes nothing", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const runPath = leaveRunBehind(sandbox);
    const before = readFileSync(runPath, "utf8");
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(readFileSync(runPath, "utf8")).toBe(before);
    expect(existsSync(lockPath(sandbox))).toBe(true);
  });

  it("does not stop the run when the record is missing, unreadable or not an object", () => {
    for (const content of [undefined, "not json", "null", "[]"]) {
      const sandbox = makeSandbox();
      addWorkItem(sandbox, "alpha");
      const runPath = leaveRunBehind(sandbox);
      if (content === undefined) rmSync(runPath);
      else writeFileSync(runPath, content);
      const result = run(sandbox, "alpha", ["--no-smoke"]);
      expect(result.status).toBe(0);
      if (content !== undefined) expect(readFileSync(runPath, "utf8")).toBe(content);
    }
  });

  it("is not looked up through a lock slug that climbs out of .work", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const outside = join(sandbox.root, "outside");
    mkdirSync(outside);
    const outsideRun = join(outside, "run.json");
    writeFileSync(outsideRun, JSON.stringify({ ...RUNNING, slug: "../outside" }));
    const deadPid = spawnSync("node", ["-e", ""]).pid;
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: deadPid, slug: "../outside" }));
    const before = readFileSync(outsideRun, "utf8");
    expect(run(sandbox, "alpha", ["--no-smoke"]).status).toBe(0);
    expect(readFileSync(outsideRun, "utf8")).toBe(before);
  });

  it("is marked lost by the next real run after a real dispatcher is killed with SIGKILL", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const release = `${sandbox.log}.release`;
    const child = spawn(
      process.execPath,
      dispatchArgs(sandbox, ["run", "alpha", "--job", "implement", "--tier", "1", "--no-smoke"]),
      { env: dispatchEnv(sandbox, { FAKE_RELEASE_FILE: release }), stdio: "ignore" },
    );
    const exited = new Promise<void>((resolveExit) => child.on("exit", () => resolveExit()));
    try {
      await vi.waitFor(() => expect(existsSync(`${sandbox.snapshot}.ready`)).toBe(true), {
        timeout: 10_000,
      });
      await vi.waitFor(
        () => {
          const lock = JSON.parse(readFileSync(lockPath(sandbox), "utf8")) as { childPid?: number };
          expect(typeof lock.childPid).toBe("number");
        },
        { timeout: 10_000 },
      );
      child.kill("SIGKILL");
      await exited;
    } finally {
      writeFileSync(release, "");
    }
    const lockedChild = (
      JSON.parse(readFileSync(lockPath(sandbox), "utf8")) as { childPid: number }
    ).childPid;
    await vi.waitFor(() => expect(isProcessAlive(lockedChild)).toBe(false), { timeout: 10_000 });
    expect(readRecord(sandbox, "alpha").status).toBe("running");
    const result = run(sandbox, "beta", ["--no-smoke"]);
    expect(result.status).toBe(0);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", lost: true });
    expect(readRecord(sandbox, "alpha").exit).toBeUndefined();
    expect(readRecord(sandbox, "beta").status).toBe("done");
  });
});

describe("the end of a run", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: true,
    dryRun: false,
  };

  const recordWhenTheLockIsRemoved = async (mainExit: string) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const seen: { status: string; exit: number | undefined }[] = [];
    vi.mocked(rmSync).mockImplementation((path, rmOptions) => {
      if (String(path) === lockPath(sandbox)) {
        const { status, exit } = readRecord(sandbox, "alpha");
        seen.push({ status, exit });
      }
      return realFs.rmSync(path, rmOptions);
    });
    const deps: DispatchDeps = {
      spawnSession: spawnSessionWithClaude,
      runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
      isProcessAlive,
      pid: process.pid,
      print: () => undefined,
    };
    const env = dispatchEnv(sandbox, { LK_ROLE: "controller", FAKE_MAIN_EXIT: mainExit });
    try {
      await dispatchRun(options, sandbox.root, env, deps);
    } finally {
      vi.mocked(rmSync).mockImplementation(realFs.rmSync);
    }
    return seen;
  };

  it.each([
    { mainExit: "0", expected: { status: "done", exit: 0 } },
    { mainExit: "3", expected: { status: "failed", exit: 3 } },
  ])(
    "has written the final record by the time the lock is removed, after a session that exits $mainExit",
    async ({ mainExit, expected }) => {
      expect(await recordWhenTheLockIsRemoved(mainExit)).toEqual([expected]);
    },
  );
});

describe("the exit a session leaves", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: true,
    dryRun: false,
  };

  const finishWith = async (end: { exitCode: number; signal?: string }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const deps: DispatchDeps = {
      spawnSession: async () => end,
      runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
      isProcessAlive: () => false,
      pid: 4242,
      print: () => undefined,
    };
    const code = await dispatchRun(options, sandbox.root, { LK_ROLE: "controller" }, deps);
    return { code, record: readRecord(sandbox, "alpha") };
  };

  it("records the signal name and exits with 128 plus its number when the session was killed", async () => {
    const { code, record } = await finishWith({ exitCode: 143, signal: "SIGTERM" });
    expect(code).toBe(143);
    expect(record).toMatchObject({ status: "failed", exit: 143, signal: "SIGTERM" });
  });

  it("records no signal when the session ended by itself", async () => {
    const { record } = await finishWith({ exitCode: 3 });
    expect(record).toMatchObject({ status: "failed", exit: 3 });
    expect("signal" in record).toBe(false);
  });
});

describe("the smoke answer", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: false,
    dryRun: false,
  };

  const refusedWith = async (answer: {
    status: number | null;
    stdout: string;
    timedOut: boolean;
  }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const started: string[] = [];
    const deps: DispatchDeps = {
      spawnSession: async (args) => {
        started.push(...args);
        return { exitCode: 0 };
      },
      runSmoke: () => answer,
      isProcessAlive: () => false,
      pid: 4242,
      print: () => undefined,
    };
    const error = await dispatchRun(options, sandbox.root, { LK_ROLE: "controller" }, deps).catch(
      (caught: unknown) => caught,
    );
    expect(started).toEqual([]);
    expect(existsSync(lockPath(sandbox))).toBe(false);
    return error;
  };

  it("refuses a null status even when the output says ok", async () => {
    const error = await refusedWith({ status: null, stdout: "ok", timedOut: false });
    expect(error).toEqual(new LkRefusal(`model ${STANDARD_MODEL} did not answer`));
  });

  it("refuses a call that ran out of time and names the limit, whatever it printed", async () => {
    const error = await refusedWith({ status: null, stdout: "ok", timedOut: true });
    expect(error).toEqual(
      new LkRefusal(
        `model ${STANDARD_MODEL} did not answer within ${SMOKE_TIMEOUT_SECONDS} seconds`,
      ),
    );
  });

  it("allows sixty seconds", () => {
    expect(SMOKE_TIMEOUT_SECONDS).toBe(60);
  });
});

describe("the smoke call as a process", () => {
  const smokeEnv = (sandbox: Sandbox, mode: string): Env =>
    dispatchEnv(sandbox, { FAKE_SMOKE: mode, LK_ROLE: "implementer" });

  it("is cut off after the time it is given and reported as timed out", () => {
    const sandbox = makeSandbox();
    const started = Date.now();
    const outcome = createRunSmoke(0.3)("claude-x", {
      cwd: sandbox.root,
      env: smokeEnv(sandbox, "hang"),
    });
    expect(outcome).toMatchObject({ status: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not call a call that answered a timeout", () => {
    const sandbox = makeSandbox();
    const outcome = createRunSmoke(30)("claude-x", {
      cwd: sandbox.root,
      env: smokeEnv(sandbox, "ok"),
    });
    expect(outcome).toMatchObject({ status: 0, timedOut: false });
    expect(outcome.stdout).toContain("OK");
  });

  it("runs in the directory it is given", () => {
    const sandbox = makeSandbox();
    createRunSmoke(30)("claude-x", { cwd: sandbox.root, env: smokeEnv(sandbox, "ok") });
    expect(realpathSync(readCalls(sandbox)[0]?.cwd ?? "")).toBe(realpathSync(sandbox.root));
  });

  it("is started with sixty seconds and a kill that cannot be ignored by the production runner", () => {
    const sandbox = makeSandbox();
    vi.mocked(spawnSync).mockClear();
    runSmokeWithClaude("claude-x", { cwd: sandbox.root, env: smokeEnv(sandbox, "ok") });
    const [, , spawnOptions] = vi.mocked(spawnSync).mock.calls[0] ?? [];
    expect(spawnOptions).toMatchObject({ timeout: 60_000, killSignal: "SIGKILL" });
  });
});

describe("isProcessAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const killFailsWith = (code: string): void => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
  };

  it("is true for a running process and false for one that is gone", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(spawnSync("node", ["-e", ""]).pid ?? -1)).toBe(false);
  });

  it("is true when the system refuses the check, because the process exists", () => {
    killFailsWith("EPERM");
    expect(isProcessAlive(1)).toBe(true);
  });

  it("is false for any other failure", () => {
    killFailsWith("ESRCH");
    expect(isProcessAlive(1)).toBe(false);
  });
});

describe("starting the session in process", () => {
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const openDescriptors = (): number => readdirSync("/dev/fd").length;

  const listenerCounts = (): Record<string, number> =>
    Object.fromEntries(SIGNALS.map((signal) => [signal, process.listenerCount(signal)]));

  const sessionIn = (
    sandbox: Sandbox,
    slug: string,
    extraEnv: Record<string, string> = {},
  ): Parameters<SpawnSession>[1] => {
    const folder = addWorkItem(sandbox, slug);
    writeFileSync(join(folder, "run.json"), "{}\n");
    return {
      cwd: sandbox.root,
      env: dispatchEnv(sandbox, { LK_SLUG: slug, ...extraEnv }),
      logPath: join(folder, "session.jsonl"),
      onSpawn: () => undefined,
    };
  };

  const realSpawn = (command: string, args: string[], options: SpawnOptions) =>
    realChildProcess.spawn(command, args, options);

  it("ends with the exit code of a session that ran to the end, and no signal", async () => {
    const sandbox = makeSandbox();
    const end = await spawnSessionWithClaude(["-p", "x"], sessionIn(sandbox, "alpha"));
    expect(end).toStrictEqual({ exitCode: 0 });
    const failed = await spawnSessionWithClaude(
      ["-p", "x"],
      sessionIn(sandbox, "beta", { FAKE_MAIN_EXIT: "3" }),
    );
    expect(failed).toStrictEqual({ exitCode: 3 });
  });

  it("ends with exit 127 when claude cannot be started", async () => {
    const sandbox = makeSandbox();
    const options = sessionIn(sandbox, "alpha", { PATH: "/nonexistent" });
    expect(await spawnSessionWithClaude(["-p", "x"], options)).toStrictEqual({ exitCode: 127 });
  });

  it("takes its signal handlers off again once the session has ended", async () => {
    const sandbox = makeSandbox();
    const before = listenerCounts();
    const descriptors = openDescriptors();
    await spawnSessionWithClaude(["-p", "x"], sessionIn(sandbox, "alpha"));
    expect(listenerCounts()).toEqual(before);
    expect(openDescriptors()).toBe(descriptors);
  });

  it("has its signal handlers in place when the session is started", async () => {
    const sandbox = makeSandbox();
    const before = listenerCounts();
    const atSpawn: Record<string, number> = {};
    vi.mocked(spawn).mockImplementationOnce(((
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => {
      for (const signal of SIGNALS)
        atSpawn[signal] = process.listenerCount(signal) - before[signal]!;
      return realSpawn(command, args, options);
    }) as typeof spawn);
    const end = await spawnSessionWithClaude(["-p", "x"], sessionIn(sandbox, "alpha"));
    expect(atSpawn).toEqual({ SIGINT: 1, SIGTERM: 1, SIGHUP: 1 });
    expect(end).toStrictEqual({ exitCode: 0 });
  });

  // A signal handler only runs on the event loop, so no real signal can reach it before the call
  // to spawn returns. The dispatcher's own registered handler is run inside that call instead,
  // which is the one state in which the session does not exist yet.
  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
    { signal: "SIGHUP" as const, exitCode: 129 },
  ])(
    "delivers $signal to a real session when it arrived before the session existed",
    async ({ signal, exitCode }) => {
      const sandbox = makeSandbox();
      const release = `${sandbox.log}.release`;
      const listenersBefore = process.listeners(signal);
      vi.mocked(spawn).mockImplementationOnce(((
        command: string,
        args: string[],
        options: SpawnOptions,
      ) => {
        const ours = process
          .listeners(signal)
          .filter((listener) => !listenersBefore.includes(listener));
        expect(ours).toHaveLength(1);
        ours[0]?.(signal);
        return realSpawn(command, args, options);
      }) as typeof spawn);
      try {
        const options = sessionIn(sandbox, "alpha", { FAKE_RELEASE_FILE: release });
        const end = await spawnSessionWithClaude(["-p", "x"], options);
        expect(end).toStrictEqual({ exitCode, signal });
      } finally {
        writeFileSync(release, "");
      }
    },
  );

  it("closes its log and takes its handlers off when the session cannot be started at all", async () => {
    const sandbox = makeSandbox();
    const before = listenerCounts();
    const descriptors = openDescriptors();
    vi.mocked(spawn).mockImplementationOnce((() => {
      throw new Error("spawn exploded");
    }) as typeof spawn);
    await expect(spawnSessionWithClaude(["-p", "x"], sessionIn(sandbox, "alpha"))).rejects.toThrow(
      "spawn exploded",
    );
    expect(listenerCounts()).toEqual(before);
    expect(openDescriptors()).toBe(descriptors);
  });

  it("kills the session, then rejects with the cause, when onSpawn throws", async () => {
    const sandbox = makeSandbox();
    const release = `${sandbox.log}.release`;
    const before = listenerCounts();
    const descriptors = openDescriptors();
    let childPid = -1;
    try {
      const options = sessionIn(sandbox, "alpha", { FAKE_RELEASE_FILE: release });
      options.onSpawn = (pid: number) => {
        childPid = pid;
        throw new Error("lock rewrite failed");
      };
      await expect(spawnSessionWithClaude(["-p", "x"], options)).rejects.toThrow(
        "lock rewrite failed",
      );
      expect(childPid).toBeGreaterThan(0);
      expect(isProcessAlive(childPid)).toBe(false);
      expect(listenerCounts()).toEqual(before);
      expect(openDescriptors()).toBe(descriptors);
    } finally {
      writeFileSync(release, "");
    }
  });

  it("leaves a lock, a failed record and no live session when the lock rewrite fails in a real dispatch", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const release = `${sandbox.log}.release`;
    let childPid = -1;
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const deps: DispatchDeps = {
      spawnSession: (args, options) =>
        spawnSessionWithClaude(args, {
          ...options,
          onSpawn: (pid) => {
            childPid = pid;
            options.onSpawn(pid);
          },
        }),
      runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
      isProcessAlive,
      pid: process.pid,
      print: () => undefined,
    };
    const env = dispatchEnv(sandbox, { LK_ROLE: "controller", FAKE_RELEASE_FILE: release });
    try {
      await expect(
        dispatchRun(
          {
            slug: "alpha",
            job: "implement",
            tier: "1",
            model: undefined,
            noSmoke: true,
            dryRun: false,
          },
          sandbox.root,
          env,
          deps,
        ),
      ).rejects.toThrow("disk full");
      expect(isProcessAlive(childPid)).toBe(false);
      expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 1 });
      expect(existsSync(lockPath(sandbox))).toBe(false);
    } finally {
      writeFileSync(release, "");
    }
  });
});

describe("the deny list as data", () => {
  it("is the patterns joined by commas, in order", () => {
    expect(DENY_LIST).toBe(DENY_PATTERNS.join(","));
  });
});
