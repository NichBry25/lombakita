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
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeArgs,
  buildSmokeArgs,
  createRunSmoke,
  DENY_LIST,
  DENY_PATTERNS,
  dispatchRun,
  gitFormsEndingIn,
  initWorkItem,
  isProcessAlive,
  PROTECTED_SET,
  pushClusterPatterns,
  readRunStatus,
  restoreDiscardPatterns,
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
import { PROTECTED_PATHS } from "./protect-table";
import { diffSnapshots, snapshotProtectedPaths, type SnapshotEntry } from "./protected-snapshot";

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
      "Bash(git * push --force*)",
      "Bash(git * push -f*)",
      "Bash(git reset --hard*)",
      "Bash(git * reset --hard*)",
      "Bash(git clean*)",
      "Bash(git * clean*)",
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
    "push --force*",
    "push -f*",
    "push * --force*",
    "push * -f*",
    "push * +*",
    "push *main*",
    "push",
    "push origin",
    "push *HEAD*",
    "push *--all*",
    "push *--mirror*",
    "push *--delete*",
    "push -d*",
    "push * -d*",
    "push *:**",
    "push -u",
    "push -u origin",
    "branch -D*",
    "branch -f*",
    "branch * -f*",
    "branch --force*",
    "branch * --force*",
    "branch -df*",
    "branch * -D*",
  ])("name git %s plain, after a global option, and as rtk rewrites both", (rest) => {
    expect(DENY_PATTERNS).toContain(`Bash(git ${rest})`);
    expect(DENY_PATTERNS).toContain(`Bash(git * ${rest})`);
    expect(DENY_PATTERNS).toContain(`Bash(rtk git ${rest})`);
    expect(DENY_PATTERNS).toContain(`Bash(rtk git * ${rest})`);
  });

  it.each([
    "reset --hard*",
    "reset * --hard*",
    "clean*",
    "checkout -f*",
    "checkout * -f*",
    "checkout --force*",
    "switch -f*",
    "switch * -f*",
    "switch --discard-changes*",
    "switch * --discard-changes*",
    "checkout -B*",
    "checkout * -B*",
    "switch -C*",
    "switch * -C*",
  ])("name git %s plain and after a global option, not as rtk rewrites it", (rest) => {
    expect(DENY_PATTERNS).toContain(`Bash(git ${rest})`);
    expect(DENY_PATTERNS).toContain(`Bash(git * ${rest})`);
    expect(DENY_PATTERNS).not.toContain(`Bash(rtk git ${rest})`);
  });

  it.each([["checkout ."], ["checkout ./"], ["checkout * ."], ["checkout * ./"]])(
    "name git %s with and without arguments after it, plain and after a global option",
    (rest) => {
      for (const pattern of gitFormsEndingIn(rest)) expect(DENY_PATTERNS).toContain(pattern);
    },
  );

  it.each([
    ["rm with a capital R flag", "Bash(rm -R*)"],
    ["rm with --recursive", "Bash(rm --recursive*)"],
    ["rm with -r given as a separate flag", "Bash(rm * -r*)"],
    ["rm with -R given as a separate flag", "Bash(rm * -R*)"],
    ["rm with --recursive given as a separate flag", "Bash(rm * --recursive*)"],
    ["rm reached by an absolute path", "Bash(/*/rm *)"],
    ["any git reached by an absolute path", "Bash(/*/git *)"],
    ["the Read tool on the topic folder", "Read(~/.config/lombakita/**)"],
    ["the Edit tool on the topic folder", "Edit(~/.config/lombakita/**)"],
    ["the Write tool on the topic folder", "Write(~/.config/lombakita/**)"],
    ["cat on the topic folder", "Bash(cat *.config/lombakita/*)"],
    ["head on the topic folder", "Bash(head *.config/lombakita/*)"],
    ["tail on the topic folder", "Bash(tail *.config/lombakita/*)"],
    ["less on the topic folder", "Bash(less *.config/lombakita/*)"],
    ["grep on the topic folder", "Bash(grep *.config/lombakita/*)"],
    [
      "cat and head on the topic folder, as rtk rewrites them",
      "Bash(rtk read *.config/lombakita/*)",
    ],
    ["grep on the topic folder, as rtk rewrites it", "Bash(rtk grep *.config/lombakita/*)"],
    ["gh, as rtk rewrites it", "Bash(rtk gh *)"],
    ["a db script, spelled so db:reset matches", "Bash(npm run db*)"],
    ["a db script, as rtk rewrites it", "Bash(rtk npm run db*)"],
  ])("name %s", (_what, pattern) => {
    expect(DENY_PATTERNS).toContain(pattern);
  });

  it("name no git rule with a -C twin, since the wildcard after git covers every global option", () => {
    expect(DENY_PATTERNS.filter((pattern) => pattern.includes("git -C"))).toEqual([]);
  });

  it("are each named once, none with a comma, and 926 in all", () => {
    expect(DENY_PATTERNS).toHaveLength(926);
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

// Stands in for the permission matcher's reading of a Bash pattern: `*` is the only wildcard, every
// other character is literal, a trailing ` *` matches the bare command only when it is the pattern's
// one wildcard, and a pattern ending in `:*` is the old prefix syntax, which matches the prefix alone
// or followed by a space and so never `npm run db:reset`. A match here predicts the matcher; only a
// real session proves it (scripts/lk/deny-proof.ts).
const compiledPatterns = new Map<string, (command: string) => boolean>();

const compilePattern = (pattern: string): ((command: string) => boolean) => {
  const body = pattern.replace(/^Bash\((.*)\)$/, "$1");
  if (body.endsWith(":*")) {
    const prefix = body.slice(0, -2);
    return (command) => command === prefix || command.startsWith(`${prefix} `);
  }
  const core = body.endsWith(" *") ? body.slice(0, -2) : body;
  const bareEndingMatches = body.endsWith(" *") && !core.includes("*");
  const source = core
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const arguments_ = body.endsWith(" *") ? (bareEndingMatches ? "( .*)?" : " .*") : "";
  const expression = new RegExp(`^${source}${arguments_}$`);
  return (command) => expression.test(command);
};

const patternMatches = (pattern: string, command: string): boolean => {
  let matches = compiledPatterns.get(pattern);
  if (matches === undefined) {
    matches = compilePattern(pattern);
    compiledPatterns.set(pattern, matches);
  }
  return matches(command);
};

const patternsDenying = (command: string): string[] =>
  DENY_PATTERNS.filter((pattern) => patternMatches(pattern, command));

// Every cluster of one to three of the letters, as a flag spelling without its dash.
const clustersOver = (letters: string[]): string[] => {
  const two = letters.flatMap((first) => letters.map((second) => `${first}${second}`));
  const three = two.flatMap((pair) => letters.map((third) => `${pair}${third}`));
  return [...letters, ...two, ...three];
};

describe("the rm flag clusters", () => {
  const LETTERS = ["d", "f", "i", "I", "P", "R", "r", "v", "W", "x"];

  const everyClusterWithAnR = (): string[] =>
    clustersOver(LETTERS).filter((cluster) => /[rR]/.test(cluster));

  it("are generated as 144 clusters, each as the first flag and as a later flag", () => {
    const patterns = rmClusterPatterns();
    expect(patterns).toHaveLength(288);
    expect(new Set(patterns).size).toBe(288);
    expect(patterns).toContain("Bash(rm -fr*)");
    expect(patterns).toContain("Bash(rm * -fr*)");
    expect(patterns).toContain("Bash(rm -vfR*)");
    expect(patterns).toContain("Bash(rm * -iiR*)");
    expect(patterns).toContain("Bash(rm -dfr*)");
    expect(patterns).toContain("Bash(rm -Pr*)");
    expect(patterns).toContain("Bash(rm * -xWr*)");
    expect(patterns).toContain("Bash(rm -IIR*)");
    expect(patterns).not.toContain("Bash(rm -r*)");
    expect(patterns).not.toContain("Bash(rm -R*)");
  });

  it("are all in the deny list", () => {
    for (const pattern of rmClusterPatterns()) expect(DENY_PATTERNS).toContain(pattern);
  });

  it("leave no cluster of one to three of the macOS rm letters that holds an r or R uncovered", () => {
    const clusters = everyClusterWithAnR();
    expect(clusters).toHaveLength(526);
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
      "rm -dPx keep.txt",
      "rm -f keep-report.txt",
      "rm -- keep.txt",
    ]) {
      expect(patternsDenying(command), command).toEqual([]);
    }
  });
});

describe("the push flag clusters", () => {
  const LETTERS = ["u", "v", "n", "q", "f", "d"];

  const everyClusterWithAForceOrDelete = (): string[] =>
    clustersOver(LETTERS).filter((cluster) => /[fd]/.test(cluster));

  it("are generated as 40 clusters, each as the first and a later flag in four forms", () => {
    const patterns = pushClusterPatterns();
    expect(patterns).toHaveLength(320);
    expect(new Set(patterns).size).toBe(320);
    expect(patterns).toContain("Bash(git push -uf*)");
    expect(patterns).toContain("Bash(git push * -uf*)");
    expect(patterns).toContain("Bash(git * push -vd*)");
    expect(patterns).toContain("Bash(git * push * -nqf*)");
    expect(patterns).toContain("Bash(rtk git push -qnd*)");
    expect(patterns).toContain("Bash(rtk git * push * -uud*)");
    expect(patterns).not.toContain("Bash(git push -f*)");
    expect(patterns).not.toContain("Bash(git push -d*)");
    expect(patterns).not.toContain("Bash(git push -u*)");
  });

  it("are all in the deny list", () => {
    for (const pattern of pushClusterPatterns()) expect(DENY_PATTERNS).toContain(pattern);
  });

  it("leave no cluster of one to three of the push short flags that holds an f or d uncovered", () => {
    const clusters = everyClusterWithAForceOrDelete();
    expect(clusters).toHaveLength(174);
    for (const cluster of clusters) {
      for (const command of [
        `git push -${cluster} origin feature`,
        `git push origin feature -${cluster}`,
        `git -c k=v push -${cluster} origin feature`,
        `git -c k=v push origin feature -${cluster}`,
        `rtk git push -${cluster} origin feature`,
        `rtk git -c k=v push origin feature -${cluster}`,
      ]) {
        expect(patternsDenying(command), command).not.toEqual([]);
      }
    }
  });

  it("let through a cluster with no f or d", () => {
    for (const command of [
      "git push -u origin feature",
      "git push -v origin feature",
      "git push -uv origin feature",
      "git push -unq origin feature",
      "git push origin feature -u",
      "git -c k=v push -u origin feature",
    ]) {
      expect(patternsDenying(command), command).toEqual([]);
      expect(patternsDenying(`rtk ${command}`), `rtk ${command}`).toEqual([]);
    }
  });
});

describe("the whole-tree restore patterns", () => {
  it("are generated as 152 patterns for the dot and the dot with a slash", () => {
    const patterns = restoreDiscardPatterns();
    expect(patterns).toHaveLength(152);
    expect(new Set(patterns).size).toBe(152);
    expect(patterns).toContain("Bash(git restore .)");
    expect(patterns).toContain("Bash(git restore ./ *)");
    expect(patterns).toContain("Bash(git * restore *-q .)");
    expect(patterns).toContain("Bash(git * restore *--quiet ./ *)");
    expect(patterns).toContain("Bash(git restore *W* .)");
    expect(patterns).toContain("Bash(git restore *--worktree* .)");
    expect(patterns).not.toContain("Bash(git restore *--staged .)");
  });

  it("are all in the deny list", () => {
    for (const pattern of restoreDiscardPatterns()) expect(DENY_PATTERNS).toContain(pattern);
  });

  it("name the bare ending, the ending with arguments, and both after a global option", () => {
    expect(gitFormsEndingIn("restore .")).toEqual([
      "Bash(git restore .)",
      "Bash(git restore . *)",
      "Bash(git * restore .)",
      "Bash(git * restore . *)",
    ]);
  });
});

describe("the pattern emulation", () => {
  it("reads a pattern ending in :* as a prefix, so db:* never names db:reset", () => {
    expect(patternMatches("Bash(npm run db:*)", "npm run db")).toBe(true);
    expect(patternMatches("Bash(npm run db:*)", "npm run db x")).toBe(true);
    expect(patternMatches("Bash(npm run db:*)", "npm run db:reset")).toBe(false);
    expect(patternMatches("Bash(npm run db*)", "npm run db:reset")).toBe(true);
  });

  it("lets a trailing space and star match the bare command but not a longer first word", () => {
    expect(patternMatches("Bash(git restore . *)", "git restore .")).toBe(true);
    expect(patternMatches("Bash(git restore . *)", "git restore . x")).toBe(true);
    expect(patternMatches("Bash(git restore . *)", "git restore .gitignore")).toBe(false);
  });

  it("does not let a trailing space and star match the bare command once an earlier star exists", () => {
    expect(patternMatches("Bash(git -C * restore . *)", "git -C /tmp/x restore .")).toBe(false);
    expect(patternMatches("Bash(git -C * restore . *)", "git -C /tmp/x restore . x")).toBe(true);
    expect(patternMatches("Bash(git -C * restore .)", "git -C /tmp/x restore .")).toBe(true);
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
    ["git push -u", "rtk git push -u"],
    ["git push -u origin", "rtk git push -u origin"],
    ["git push -uf origin feature", "rtk git push -uf origin feature"],
    ["git push -vf origin feature", "rtk git push -vf origin feature"],
    ["git push -vd origin feature", "rtk git push -vd origin feature"],
    ["git push origin feature -uf", "rtk git push origin feature -uf"],
    ["git -C /tmp/x push -u origin HEAD", "rtk git -C /tmp/x push -u origin HEAD"],
    ["git -C /tmp/x push --all", "rtk git -C /tmp/x push --all"],
    ["git -C /tmp/x push origin :feature", "rtk git -C /tmp/x push origin :feature"],
    ["git -c core.pager=cat push origin main", "rtk git -c core.pager=cat push origin main"],
    [
      "git -c core.pager=cat push --force origin feature",
      "rtk git -c core.pager=cat push --force origin feature",
    ],
    [
      "git --no-pager push --force origin feature",
      "rtk git --no-pager push --force origin feature",
    ],
    [
      "git --git-dir=/tmp/x/.git push origin main",
      "rtk git --git-dir=/tmp/x/.git push origin main",
    ],
    ["git -c k=v push", "rtk git -c k=v push"],
    ["git -c k=v push origin", "rtk git -c k=v push origin"],
    ["git -c k=v push -uf origin feature", "rtk git -c k=v push -uf origin feature"],
    ["git -c k=v push origin +feature", "rtk git -c k=v push origin +feature"],
    ["/usr/bin/git push --force origin feature", "/usr/bin/git push --force origin feature"],
    ["/usr/bin/git push origin feature", "/usr/bin/git push origin feature"],
    ["/usr/bin/git -C /tmp/x push origin feature", "/usr/bin/git -C /tmp/x push origin feature"],
    ["git branch --delete --force feature-two", "rtk git branch --delete --force feature-two"],
    ["git branch --force --delete feature-two", "rtk git branch --force --delete feature-two"],
    ["git branch -d -f feature-two", "rtk git branch -d -f feature-two"],
    ["git branch -f -d feature-two", "rtk git branch -f -d feature-two"],
    ["git branch -df feature-two", "rtk git branch -df feature-two"],
    ["git branch -f feature-two main", "rtk git branch -f feature-two main"],
    ["git -c k=v branch -D feature-two", "rtk git -c k=v branch -D feature-two"],
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
    "rm -dfr victim",
    "rm -Pr victim",
    "rm -xWR victim",
    "rm victim -dfr",
    "git reset --hard",
    "git reset HEAD --hard",
    "git reset -q --hard HEAD",
    "git reset --hard HEAD~1",
    "git -c k=v reset --hard",
    "git -c k=v reset HEAD --hard",
    "git clean -fd",
    "git -c k=v clean -fd",
    "git restore -- .",
    "git restore .",
    "git restore ./",
    "git restore -q .",
    "git restore --quiet .",
    "git restore --worktree .",
    "git restore -W .",
    "git restore -SW .",
    "git restore --worktree --staged .",
    "git restore --staged --worktree .",
    "git restore --source=HEAD~1 .",
    "git restore -s HEAD~1 .",
    "git restore --source=HEAD~1 -q .",
    "git -C /tmp/x restore -- .",
    "git -c k=v restore .",
    "git -c k=v restore -q ./",
    "git checkout .",
    "git checkout ./",
    "git checkout -- .",
    "git checkout HEAD .",
    "git checkout HEAD ./",
    "git checkout HEAD -- .",
    "git checkout feature .",
    "git checkout -f",
    "git checkout -f feature",
    "git checkout feature -f",
    "git checkout --force",
    "git -C /tmp/x checkout -f",
    "git -c k=v checkout .",
    "git -c k=v checkout HEAD .",
    "git switch -f feature",
    "git switch feature -f",
    "git switch --discard-changes feature",
    "git checkout -B main",
    "git switch -C main",
    "git -c k=v switch -C main",
    "git checkout feature -B main",
  ])("deny %s", (command) => {
    expect(patternsDenying(command), command).not.toEqual([]);
  });

  it.each([
    "git push origin feature",
    "git push -u origin feature",
    "git push -v origin feature",
    "git push -uv origin feature",
    "git push origin feature-fix",
    "git push origin feature-draft",
    "git -C /tmp/x push origin feature",
    "git -c core.pager=cat push origin feature",
    "git --no-pager push -u origin feature",
    "git checkout feature",
    "git checkout -b feature-three",
    "git switch feature",
    "git switch -c feature-three",
    "git restore .gitignore",
    "git restore --staged keep.txt",
    "git restore --staged .",
    "git restore --staged ./",
    "git restore -S .",
    "git restore keep.txt",
    "git restore -q keep.txt",
    "git -c k=v restore --staged .",
    "git checkout .github/x",
    "git checkout -- .gitignore",
    "git checkout HEAD keep.txt",
    "git branch feature-three",
    "git branch -d merged-branch",
    "git -C /tmp/x branch --list",
    "git stash",
    "git stash pop",
    "git add keep.txt",
    "git commit -m x",
    "git -c k=v commit -m x",
    "git status",
    "git diff",
    "git log",
    "rm keep.txt",
    "rm -f keep.txt",
    "rm -v keep.txt",
    "rm -f keep-report.txt",
    "rm -- keep.txt",
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

describe("the governance grant", () => {
  const writeSpec = (sandbox: Sandbox, slug: string, text: string): void => {
    writeFileSync(join(sandbox.root, ".work", slug, "01-spec.md"), text);
  };

  const grantEnvOf = (call: Call | undefined): string | undefined =>
    /LK_GOVERNANCE_GRANT=(.*)$/.exec(call?.env ?? "")?.[1];

  const runWithSpec = (
    spec: string | undefined,
    overrides: Record<string, string | undefined> = {},
  ) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    if (spec !== undefined) writeSpec(sandbox, "alpha", spec);
    return { sandbox, result: run(sandbox, "alpha", [], overrides) };
  };

  const expectGrantInBothCalls = (sandbox: Sandbox, grant: string): void => {
    const [smoke, session, ...rest] = readCalls(sandbox);
    expect(rest).toEqual([]);
    expect(grantEnvOf(smoke)).toBe(grant);
    expect(grantEnvOf(session)).toBe(grant);
  };

  it("is the empty string in the smoke call and the session when the work item has no spec", () => {
    const { sandbox, result } = runWithSpec(undefined);
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "");
  });

  it.each([
    ["a spec with no grant line", "Goal: something\n"],
    ["a grant line with nothing after it", "governance-grant:\n"],
    ["a grant line with only blanks after it", "governance-grant:   \t \n"],
    [
      "a line that mentions the grant mid-sentence",
      "Grant line note: governance-grant: docs/project/SSOT.md\n",
    ],
    ["an indented grant line", "  governance-grant: docs/project/SSOT.md\n"],
  ])("is the empty string for %s", (_name, spec) => {
    const { sandbox, result } = runWithSpec(spec);
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "");
  });

  it("is the entries of the grant line joined by colons, split on any whitespace", () => {
    const { sandbox, result } = runWithSpec(
      "Goal: x\ngovernance-grant:  docs/project/SSOT.md\tdocs/.claude/  .github/workflows/x.yml \r\nMore text\n",
    );
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "docs/project/SSOT.md:docs/.claude/:.github/workflows/x.yml");
  });

  it("reads only the grant line, not a parenthesised remark on the next line", () => {
    const { sandbox, result } = runWithSpec(
      "governance-grant: docs/project/SSOT.md\n(Owner ruling: exact paths, a record only.)\n",
    );
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "docs/project/SSOT.md");
  });

  it("accepts the spellings the refusals below have good twins for", () => {
    const entries = [
      "docs/project/SSOT.md",
      "docs/project/",
      "docs/.claude/settings.json",
      "docs/contracts/",
      ".gitignore",
      ".github/workflows/x.yml",
    ];
    const { sandbox, result } = runWithSpec(`governance-grant: ${entries.join(" ")}\n`);
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, entries.join(":"));
  });

  it("is the real path of each entry, relative to the product root, a folder keeping its slash", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    mkdirSync(join(sandbox.root, "docs/product/contracts"), { recursive: true });
    symlinkSync("product/contracts", join(sandbox.root, "docs/contracts"));
    writeFileSync(join(sandbox.root, "docs/project/SSOT.md"), "x");
    symlinkSync("project/SSOT.md", join(sandbox.root, "docs/ssot-link.md"));
    writeSpec(sandbox, "alpha", "governance-grant: docs/contracts/ docs/ssot-link.md\n");
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "docs/product/contracts/:docs/project/SSOT.md");
  });

  it("is spelled below docs/ when docs/ is a link to a checkout outside the product root", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const checkout = join(dirname(sandbox.root), "docs-checkout");
    renameSync(join(sandbox.root, "docs"), checkout);
    symlinkSync(checkout, join(sandbox.root, "docs"));
    writeSpec(sandbox, "alpha", "governance-grant: docs/project/SSOT.md docs/project/\n");
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "docs/project/SSOT.md:docs/project/");
  });

  it("overwrites a value in the controller's own environment when the spec has no grant line", () => {
    const leaked = { LK_GOVERNANCE_GRANT: "docs/project/SSOT.md" };
    const { sandbox, result } = runWithSpec(undefined, leaked);
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "");
  });

  it("overwrites a value in the controller's own environment with the spec's own entries", () => {
    const leaked = { LK_GOVERNANCE_GRANT: "docs/product/state-machines.md" };
    const { sandbox, result } = runWithSpec("governance-grant: docs/project/SSOT.md\n", leaked);
    expect(result.status).toBe(0);
    expectGrantInBothCalls(sandbox, "docs/project/SSOT.md");
  });

  it("hands the session its grant without starting a process, and never a leaked one", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeSpec(sandbox, "alpha", "governance-grant: docs/project/SSOT.md docs/.claude/\n");
    const sessions: Env[] = [];
    const smokes: Env[] = [];
    const deps: DispatchDeps = {
      spawnSession: async (_args, { env }) => {
        sessions.push(env);
        return { exitCode: 0 };
      },
      runSmoke: (_model, smokeOptions) => {
        smokes.push(smokeOptions.env);
        return { status: 0, stdout: "ok", timedOut: false };
      },
      isProcessAlive: () => true,
      pid: 4242,
      print: () => undefined,
    };
    const options: RunOptions = {
      slug: "alpha",
      job: "implement",
      tier: "1",
      model: undefined,
      noSmoke: false,
      dryRun: false,
    };
    const leaked = { LK_ROLE: "controller", LK_GOVERNANCE_GRANT: "docs/product/state-machines.md" };
    await dispatchRun(options, sandbox.root, leaked, deps);
    expect(sessions[0]?.LK_GOVERNANCE_GRANT).toBe("docs/project/SSOT.md:docs/.claude/");
    expect(smokes[0]?.LK_GOVERNANCE_GRANT).toBe("docs/project/SSOT.md:docs/.claude/");
  });

  // Each refusal is shown with a good entry beside the bad one, so the refusal is the bad entry's.
  const REFUSED_ENTRIES: [kind: string, entry: string, reason: string][] = [
    ["an entry holding a colon", "docs/a:b", "holds a colon"],
    ["an absolute entry", "/etc/hosts", "starts with a slash"],
    ["an entry starting with a tilde", "~/x", "starts with a tilde"],
    ["an entry holding ..", "docs/../x", "holds .."],
    ["an entry climbing out of the root", "../outside/x", "holds .."],
    ["an entry with a star", "docs/*", "holds a wildcard character"],
    ["an entry with a question mark", "docs/project/SSOT.m?", "holds a wildcard character"],
    ["an entry with a bracket", "docs/project/[a]", "holds a wildcard character"],
    ["the product root as a dot", ".", "resolves to the product root"],
    ["the product root with a slash", "./", "resolves to the product root"],
    ["the docs root with a slash", "docs/", "resolves to the docs root"],
    ["the docs root with no slash", "docs", "resolves to the docs root"],
    ["a path under .git", ".git/config", "resolves to a path under .git"],
    ["a path under docs/.git", "docs/.git/config", "resolves to a path under .git"],
    ["a path under .git in another letter case", ".GIT/config", "resolves to a path under .git"],
    [
      "an existing folder with no trailing slash",
      "docs/project",
      "names a folder without a trailing slash",
    ],
    [
      "a path through a link to outside the repository",
      "link-out/x.md",
      "resolves outside the product root",
    ],
  ];

  it.each(REFUSED_ENTRIES)("refuses %s before anything is started", (_kind, entry, reason) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const outside = join(dirname(sandbox.root), "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(sandbox.root, "link-out"));
    writeSpec(sandbox, "alpha", `governance-grant: docs/project/SSOT.md ${entry}\n`);
    const result = run(sandbox, "alpha", [], { FAKE_SMOKE: "fail" });
    expectRefused(result, `governance grant entry "${entry}" ${reason}`, sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses a spec that holds two grant lines, before anything is started", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeSpec(
      sandbox,
      "alpha",
      "governance-grant: docs/project/SSOT.md\ngovernance-grant: docs/.claude/\n",
    );
    const result = run(sandbox, "alpha", [], { FAKE_SMOKE: "fail" });
    expectRefused(result, "holds 2 governance-grant: lines, not 1", sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses a bad entry on a dry run too, and writes nothing", () => {
    const sandbox = makeSandbox();
    const folder = addWorkItem(sandbox, "alpha");
    writeSpec(sandbox, "alpha", "governance-grant: docs/\n");
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('governance grant entry "docs/" resolves to the docs root');
    expect(readdirSync(folder).sort()).toEqual(["01-spec.md", "02-prompt.md"]);
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
    expect(smoke?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha LK_GOVERNANCE_GRANT=");
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
    expect(session?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha LK_GOVERNANCE_GRANT=");
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
        env: { LK_ROLE: "implementer", LK_SLUG: "alpha", LK_GOVERNANCE_GRANT: "", KEEP: "yes" },
        logPath: join(sandbox.root, ".work/alpha/session.jsonl"),
      },
    ]);
    expect(smokes).toEqual([
      {
        model: STANDARD_MODEL,
        env: { LK_ROLE: "implementer", LK_SLUG: "alpha", LK_GOVERNANCE_GRANT: "", KEEP: "yes" },
      },
    ]);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 5, pid: 4242 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses to start when another dispatch takes the lock first, before the smoke call", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    vi.mocked(linkSync).mockImplementationOnce((source, target) => {
      writeFileSync(target, JSON.stringify({ pid: 1, slug: "rival" }));
      return realFs.linkSync(source, target);
    });
    const { deps, sessions, smokes } = seams();
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      new LkRefusal("slug rival holds the lock"),
    );
    expect(smokes).toEqual([]);
    expect(sessions).toEqual([]);
    expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
    expect(readFileSync(lockPath(sandbox), "utf8")).toContain("rival");
  });

  it("holds the lock while the smoke call runs", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    let lockDuringSmoke: unknown;
    const { deps } = seams({
      runSmoke: () => {
        lockDuringSmoke = JSON.parse(readFileSync(lockPath(sandbox), "utf8"));
        return { status: 0, stdout: "ok", timedOut: false };
      },
    });
    await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(lockDuringSmoke).toEqual({ pid: 4242, slug: "alpha" });
    expect(existsSync(lockPath(sandbox))).toBe(false);
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
    vi.mocked(linkSync).mockImplementationOnce((source, target) => {
      writeFileSync(target, JSON.stringify({ pid: 1, slug: "rival" }));
      return realFs.linkSync(source, target);
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps())).rejects.toThrow(
      new LkRefusal("slug rival holds the lock"),
    );
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

// A settings case with no covers runs with no deny flag, so a hook is the only thing that can
// refuse its command and the deny list never sees it. The twin cases carry covers and stay.
const SETTINGS_CASES_WITHOUT_COVERS = [
  "hook-pipe-to-psql",
  "hook-bash-c-psql",
  "hook-env-psql",
  "hook-sudo-psql",
  "hook-bare-drizzle-kit-migrate",
  "hook-docker-exec-psql",
  "hook-npm-db-reset-with-sql",
  "ok-hook-heredoc-sql-text",
  "ok-hook-echo-drop-table-to-file",
  "ok-hook-grep-drizzle-folder",
  "ok-hook-npm-db-reset",
  "hook-protect-impl-ssot",
  "hook-protect-impl-state-machines",
  "hook-protect-impl-contracts",
  "hook-protect-impl-product-contracts",
  "hook-protect-impl-claude-dir",
  "hook-protect-impl-rulebook",
  "hook-protect-impl-models",
  "hook-protect-impl-git",
  "hook-protect-impl-git-redirect",
  "hook-protect-grant-allowed",
  "hook-protect-grant-other-path",
  "hook-protect-controller",
  "hook-protect-bash-redirect",
  "hook-protect-case",
  "hook-protect-traversal",
  "hook-protect-grant-symlink",
  "hook-protect-grant-whole-docs",
  "hook-protect-control",
  "hook-protect-git-command",
  "hook-protect-backlog",
  "hook-session-end",
];

interface CaseCovers {
  id: string;
  mode?: string;
  covers: readonly string[];
}

const isSettingsCaseWithoutCovers = (testCase: CaseCovers): boolean =>
  testCase.mode === "settings" && testCase.covers.length === 0;

const exclusionProblems = (cases: readonly CaseCovers[], listed: readonly string[]): string[] => [
  ...listed
    .filter(
      (id) =>
        !cases.some((testCase) => testCase.id === id && isSettingsCaseWithoutCovers(testCase)),
    )
    .map((id) => `${id} is listed but is not a settings case with no covers`),
  ...cases
    .filter((testCase) => isSettingsCaseWithoutCovers(testCase) && !listed.includes(testCase.id))
    .map((testCase) => `${testCase.id} is a settings case with no covers and is not listed`),
];

describe("the deny-proof harness without a model", () => {
  const harness = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/lk/deny-proof.ts", ...args], {
      encoding: "utf8",
      env,
    });

  it("lists every case, each naming a pattern the deny list holds, and starts nothing", () => {
    const result = harness(["--list"]);
    expect(result.status).toBe(0);
    const rows = result.stdout.trimEnd().split("\n");
    for (const row of rows) expect(row.split("\t")).toHaveLength(3);
    const groups = new Set(rows.map((row) => row.split("\t")[0]));
    for (const group of ["standins", "allowed", "topic-write", "push-new-a", "rm-new"]) {
      expect(groups).toContain(group);
    }
  });

  // A control run drops exactly the covering patterns, so a pattern that names the command and is
  // missing from them keeps the control refused and the case reads INVALID.
  it("gives every Bash case a covers list that holds every pattern naming its command, and no allowed control a refusing pattern", async () => {
    const { CASES } = await import("./deny-proof");
    const problems: string[] = [];
    const bashCases = CASES.filter(
      (candidate) =>
        candidate.tool === "Bash" && !SETTINGS_CASES_WITHOUT_COVERS.includes(candidate.id),
    );
    for (const testCase of bashCases) {
      const command = testCase.command.split("<fixture>").join("/tmp/lk-deny-proof-x/repo");
      const rewritten = testCase.rewrittenAs?.split("<fixture>").join("/tmp/lk-deny-proof-x/repo");
      const naming = [
        ...new Set([
          ...patternsDenying(command),
          ...patternsDenying(rewritten ?? `rtk ${command}`),
        ]),
      ];
      const missing =
        testCase.allowedEffect === undefined
          ? naming.filter((pattern) => !testCase.covers.includes(pattern))
          : naming;
      if (missing.length > 0) problems.push(`${testCase.id}: ${command} <- ${missing.join(" ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("lists every settings case with no covers that the deny list check leaves out, and no other", async () => {
    const { CASES } = await import("./deny-proof");
    expect(exclusionProblems(CASES, SETTINGS_CASES_WITHOUT_COVERS)).toEqual([]);
  });

  it("names a listed id that is not a settings case with no covers, or is no case at all", () => {
    const cases = [
      { id: "kept", mode: "settings", covers: ["Bash(x*)"] },
      { id: "dispatched", covers: [] },
    ];
    expect(exclusionProblems(cases, ["kept", "dispatched", "gone"])).toEqual([
      "kept is listed but is not a settings case with no covers",
      "dispatched is listed but is not a settings case with no covers",
      "gone is listed but is not a settings case with no covers",
    ]);
  });

  it("names a settings case with no covers that is not listed", () => {
    const cases = [
      { id: "listed", mode: "settings", covers: [] },
      { id: "unlisted", mode: "settings", covers: [] },
      { id: "twin", mode: "settings", covers: ["Bash(x*)"] },
    ];
    expect(exclusionProblems(cases, ["listed"])).toEqual([
      "unlisted is a settings case with no covers and is not listed",
    ]);
  });

  it("registers nothing and runs nothing when it is only imported", () => {
    const script = `await import("./scripts/lk/deny-proof.ts");
      console.log(["SIGINT", "SIGTERM", "SIGHUP"].map((name) => process.listenerCount(name)).join(","));`;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("0,0,0\n");
    expect(result.status).toBe(0);
  });

  it("refuses an --out path that already exists and leaves it as it was", () => {
    const sandbox = makeSandbox();
    const existing = join(dirname(sandbox.log), "existing.txt");
    writeFileSync(existing, "keep me\n");
    const result = harness([
      "--group",
      "controls",
      "--out",
      existing,
      "--models",
      join(FIXTURES, "models.md"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(existing, "utf8")).toBe("keep me\n");
  });

  it("stops the session, then removes its fixture, then reports what survived, when it is signalled", async () => {
    const sandbox = makeSandbox();
    const release = `${sandbox.log}.release`;
    const scratch = mkdtempSync(join(workspace, "proof-tmp-"));
    const out = join(scratch, "proof.txt");
    const env = dispatchEnv(sandbox, { FAKE_RELEASE_FILE: release, TMPDIR: scratch });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/lk/deny-proof.ts",
        "--group",
        "controls",
        "--case",
        "allowed-push-feature",
        "--out",
        out,
        "--models",
        join(FIXTURES, "models.md"),
      ],
      { env, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
    try {
      await vi.waitFor(() => expect(existsSync(`${sandbox.snapshot}.ready`)).toBe(true), {
        timeout: 20_000,
      });
      child.kill("SIGTERM");
      expect(await exited).toBe(143);
    } finally {
      writeFileSync(release, "");
    }
    const lines = readFileSync(out, "utf8").split("\n");
    const positionOf = (prefix: string): number =>
      lines.findIndex((line) => line.startsWith(prefix));
    expect(positionOf("SIGNAL SIGTERM: stopping 1 running session(s)")).toBeGreaterThan(-1);
    expect(positionOf("SIGNAL: removing the fixtures")).toBeGreaterThan(
      positionOf("SIGNAL SIGTERM: stopping"),
    );
    expect(lines).toContain("SIGNAL: 1 session(s) told to stop, 1 fixture(s) still in place");
    expect(lines).toContain("POSTCHECK after signal: sessions still alive: []");
    expect(lines).toContain("POSTCHECK after signal: fixtures still present: []");
    expect(lines).toContain("POSTCHECK after signal: topic decoys still present: []");
    expect(readdirSync(scratch).filter((name) => name.startsWith("lk-deny-proof-"))).toEqual([]);
  });
});

describe("the protected path check", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: true,
    dryRun: false,
  };
  const SEED_TEXT = "seed\n";
  const GIT_CONFIG_TEXT = "[core]\n\trepositoryformatversion = 0\n";
  const isRoot = process.getuid?.() === 0;

  const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

  const pathIn = (sandbox: Sandbox, path: string): string => join(sandbox.root, path);

  const readText = (sandbox: Sandbox, path: string): string =>
    readFileSync(pathIn(sandbox, path), "utf8");

  const appendTo = (sandbox: Sandbox, path: string): void =>
    appendFileSync(pathIn(sandbox, path), "changed\n");

  // Every path of the set gets something on disk. docs/contracts is a link, as it is on the owner's machine.
  const seedProtectedPaths = (sandbox: Sandbox): void => {
    for (const path of PROTECTED_SET) {
      const absolute = pathIn(sandbox, path);
      if (path === "docs/contracts/") {
        symlinkSync("product/contracts", absolute.slice(0, -1));
      } else if (path.endsWith("/")) {
        mkdirSync(absolute, { recursive: true });
        writeFileSync(join(absolute, "seed.txt"), SEED_TEXT);
      } else if (!existsSync(absolute)) {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, path.endsWith(".git/config") ? GIT_CONFIG_TEXT : SEED_TEXT);
      }
    }
  };

  const preparedSandbox = (grantLine?: string): Sandbox => {
    const sandbox = makeSandbox();
    const folder = addWorkItem(sandbox, "alpha");
    seedProtectedPaths(sandbox);
    if (grantLine !== undefined) writeFileSync(join(folder, "01-spec.md"), `${grantLine}\n`);
    return sandbox;
  };

  interface Outcome {
    code: number;
    record: RunRecord;
    printed: string[];
  }

  const depsFor = (
    printed: string[],
    act: () => void | Promise<void>,
    sessionExit: number,
    overrides: Partial<DispatchDeps> = {},
  ): DispatchDeps => ({
    spawnSession: async () => {
      await act();
      return { exitCode: sessionExit };
    },
    runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
    isProcessAlive: () => false,
    pid: 4242,
    print: (line) => printed.push(line),
    ...overrides,
  });

  const runSessionThat = async (
    sandbox: Sandbox,
    act: () => void | Promise<void>,
    sessionExit = 0,
    overrides: Partial<DispatchDeps> = {},
    runOptions: RunOptions = options,
  ): Promise<Outcome> => {
    const printed: string[] = [];
    const deps = depsFor(printed, act, sessionExit, overrides);
    const code = await dispatchRun(runOptions, sandbox.root, { LK_ROLE: "controller" }, deps);
    return { code, record: readRecord(sandbox, "alpha"), printed };
  };

  const changedLine = (path: string, change: string): string =>
    `LK PROTECTED PATH CHANGED: ${path} (${change})`;

  describe("a run that leaves the protected paths alone", () => {
    it("ends done when it changes nothing in the protected set", async () => {
      const sandbox = preparedSandbox();
      const { code, record, printed } = await runSessionThat(sandbox, () => {
        writeFileSync(pathIn(sandbox, "note.txt"), "a note outside the set\n");
        writeFileSync(
          pathIn(sandbox, "docs/project/open-debt.md"),
          "inside docs, outside the set\n",
        );
      });
      expect(code).toBe(0);
      expect(record).toMatchObject({ status: "done", exit: 0 });
      expect("changed" in record).toBe(false);
      expect("checkError" in record).toBe(false);
      expect(printed).toEqual(["LK DISPATCH alpha done exit 0"]);
      expect(existsSync(lockPath(sandbox))).toBe(false);
    });

    it("ends done when a file grant covers the file the run changes", async () => {
      const sandbox = preparedSandbox("governance-grant: docs/AGENTS.md");
      const { code, record } = await runSessionThat(sandbox, () =>
        appendTo(sandbox, "docs/AGENTS.md"),
      );
      expect(code).toBe(0);
      expect(record).toMatchObject({ status: "done", exit: 0 });
      expect("changed" in record).toBe(false);
    });

    it("ends done when a grant entry spells the path in another case", async () => {
      const sandbox = preparedSandbox("governance-grant: docs/agents.md");
      const { code, record } = await runSessionThat(sandbox, () =>
        appendTo(sandbox, "docs/AGENTS.md"),
      );
      expect(code).toBe(0);
      expect(record.status).toBe("done");
    });

    it("ends done when the file the run changes is below a folder grant", async () => {
      const sandbox = preparedSandbox("governance-grant: docs/product/contracts/");
      const { code, record } = await runSessionThat(sandbox, () => {
        appendTo(sandbox, "docs/product/contracts/seed.txt");
        writeFileSync(pathIn(sandbox, "docs/product/contracts/new.yaml"), SEED_TEXT);
      });
      expect(code).toBe(0);
      expect(record).toMatchObject({ status: "done", exit: 0 });
      expect("changed" in record).toBe(false);
    });

    it("writes the snapshot taken before the session and the one taken after it into the work folder", async () => {
      const sandbox = preparedSandbox();
      await runSessionThat(sandbox, () => appendTo(sandbox, "docs/AGENTS.md"));
      const readEvidence = (file: string): SnapshotEntry[] =>
        JSON.parse(
          readFileSync(join(sandbox.root, ".work/alpha", file), "utf8"),
        ) as SnapshotEntry[];
      const shaOf = (snapshot: SnapshotEntry[]): string | undefined =>
        snapshot.find((entry) => entry.path === "docs/AGENTS.md")?.sha256;
      expect(shaOf(readEvidence("snapshot-before.json"))).toBe(sha256Of(SEED_TEXT));
      expect(shaOf(readEvidence("snapshot-after.json"))).toBe(sha256Of(`${SEED_TEXT}changed\n`));
    });

    it("writes no evidence file and no lock on a dry run", async () => {
      const sandbox = preparedSandbox();
      const printed: string[] = [];
      const code = await dispatchRun(
        { ...options, dryRun: true },
        sandbox.root,
        { LK_ROLE: "controller" },
        depsFor(printed, () => undefined, 0),
      );
      expect(code).toBe(0);
      expect(readdirSync(join(sandbox.root, ".work/alpha"))).toEqual(["02-prompt.md"]);
      expect(existsSync(lockPath(sandbox))).toBe(false);
    });
  });

  describe("a run that changes a protected path the grant does not cover", () => {
    it("ends failed, names the file in changed, records exit 4 and returns 4, and restores nothing", async () => {
      const sandbox = preparedSandbox();
      const { code, record, printed } = await runSessionThat(sandbox, () =>
        appendTo(sandbox, "docs/AGENTS.md"),
      );
      expect(code).toBe(4);
      expect(record).toMatchObject({ status: "failed", exit: 4 });
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
      expect(printed).toEqual([
        changedLine("docs/AGENTS.md", "changed"),
        "LK DISPATCH alpha failed exit 4",
      ]);
      expect(readText(sandbox, "docs/AGENTS.md")).toBe(`${SEED_TEXT}changed\n`);
      expect(existsSync(lockPath(sandbox))).toBe(false);
    });

    it.each(PROTECTED_SET.filter((path) => !path.endsWith("/")))(
      "ends failed when the run changes the file %s",
      async (path) => {
        const sandbox = preparedSandbox();
        const { code, record } = await runSessionThat(sandbox, () => appendTo(sandbox, path));
        expect(code).toBe(4);
        expect(record.status).toBe("failed");
        expect(record.changed).toEqual([{ path, change: "changed" }]);
      },
    );

    it.each(PROTECTED_SET.filter((path) => path.endsWith("/") && path !== "docs/contracts/"))(
      "ends failed when the run adds a file below the folder %s",
      async (folder) => {
        const sandbox = preparedSandbox();
        const added = `${folder}added-by-the-session.txt`;
        const { code, record } = await runSessionThat(sandbox, () =>
          writeFileSync(pathIn(sandbox, added), SEED_TEXT),
        );
        expect(code).toBe(4);
        expect(record.status).toBe("failed");
        expect(record.changed).toEqual([{ path: added, change: "added" }]);
      },
    );

    it("ends failed when a file is added under docs/.claude", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(sandbox, () =>
        writeFileSync(pathIn(sandbox, "docs/.claude/new-command.md"), SEED_TEXT),
      );
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/.claude/new-command.md", change: "added" }]);
    });

    it("ends failed with kind changed when a protected file is replaced by a link", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(sandbox, () => {
        rmSync(pathIn(sandbox, "docs/CLAUDE.md"));
        symlinkSync("AGENTS.md", pathIn(sandbox, "docs/CLAUDE.md"));
      });
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/CLAUDE.md", change: "kind changed" }]);
      expect(readlinkSync(pathIn(sandbox, "docs/CLAUDE.md"))).toBe("AGENTS.md");
    });

    it("ends failed with kind changed when the docs/contracts link is replaced by a folder", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(sandbox, () => {
        rmSync(pathIn(sandbox, "docs/contracts"));
        mkdirSync(pathIn(sandbox, "docs/contracts"));
      });
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/contracts/", change: "kind changed" }]);
    });

    it.each(["docs/product/state-machines.md", "docs/.claude/seed.txt"])(
      "ends failed when the run changes %s outside a folder grant",
      async (path) => {
        const sandbox = preparedSandbox("governance-grant: docs/product/contracts/");
        const { code, record } = await runSessionThat(sandbox, () => appendTo(sandbox, path));
        expect(code).toBe(4);
        expect(record.status).toBe("failed");
        expect(record.changed).toEqual([{ path, change: "changed" }]);
      },
    );

    it("ends failed and lists only the path no grant covers when a granted file and another change", async () => {
      const sandbox = preparedSandbox("governance-grant: docs/AGENTS.md");
      const { code, record } = await runSessionThat(sandbox, () => {
        appendTo(sandbox, "docs/AGENTS.md");
        appendTo(sandbox, "docs/CLAUDE.md");
      });
      expect(code).toBe(4);
      expect(record.changed).toEqual([{ path: "docs/CLAUDE.md", change: "changed" }]);
    });

    it("ends failed and prints one line per path with its kind of change, in the order of the set", async () => {
      const sandbox = preparedSandbox();
      const { code, record, printed } = await runSessionThat(sandbox, () => {
        chmodSync(pathIn(sandbox, "docs/CLAUDE.md"), 0o600);
        rmSync(pathIn(sandbox, "docs/project/controller.md"));
        writeFileSync(pathIn(sandbox, "docs/.claude/new-command.md"), SEED_TEXT);
      });
      expect(code).toBe(4);
      expect(record.changed).toEqual([
        { path: "docs/CLAUDE.md", change: "changed" },
        { path: "docs/project/controller.md", change: "removed" },
        { path: "docs/.claude/new-command.md", change: "added" },
      ]);
      expect(printed).toEqual([
        changedLine("docs/CLAUDE.md", "changed"),
        changedLine("docs/project/controller.md", "removed"),
        changedLine("docs/.claude/new-command.md", "added"),
        "LK DISPATCH alpha failed exit 4",
      ]);
    });

    it("ends failed when the change is committed in the docs repository and its worktree is clean", async () => {
      const sandbox = preparedSandbox();
      const docs = pathIn(sandbox, "docs");
      const git = (...args: string[]): string => {
        const result = spawnSync(
          "git",
          [
            "-c",
            "user.name=lk-test",
            "-c",
            "user.email=lk-test@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          { cwd: docs, encoding: "utf8" },
        );
        if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
        return result.stdout;
      };
      rmSync(join(docs, ".git"), { recursive: true, force: true });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-q", "-m", "seed");
      let statusAfterCommit: string | undefined;
      const { code, record } = await runSessionThat(sandbox, () => {
        appendTo(sandbox, "docs/AGENTS.md");
        git("add", "AGENTS.md");
        git("commit", "-q", "-m", "change AGENTS.md");
        statusAfterCommit = git("status", "--porcelain");
      });
      expect(statusAfterCommit).toBe("");
      expect(git("log", "--format=%s", "-1")).toBe("change AGENTS.md\n");
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
    });

    it("ends failed when the session rewrites snapshot-before.json to match what it did", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(sandbox, () => {
        appendTo(sandbox, "docs/AGENTS.md");
        const doctored = snapshotProtectedPaths(sandbox.root, PROTECTED_SET);
        writeFileSync(
          join(sandbox.root, ".work/alpha/snapshot-before.json"),
          JSON.stringify(doctored),
        );
      });
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
    });

    it("ends failed when the session rewrites the grant line of the spec and then changes a protected file", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(sandbox, () => {
        writeFileSync(
          join(sandbox.root, ".work/alpha/01-spec.md"),
          "governance-grant: docs/AGENTS.md\n",
        );
        appendTo(sandbox, "docs/AGENTS.md");
      });
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
    });

    it("ends failed when a protected file changes during the smoke call", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await runSessionThat(
        sandbox,
        () => undefined,
        0,
        {
          runSmoke: () => {
            appendTo(sandbox, "docs/AGENTS.md");
            return { status: 0, stdout: "ok", timedOut: false };
          },
        },
        { ...options, noSmoke: false },
      );
      expect(code).toBe(4);
      expect(record.status).toBe("failed");
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
    });

    it("ends failed with the session's own exit 3 and still lists the path", async () => {
      const sandbox = preparedSandbox();
      const { code, record, printed } = await runSessionThat(
        sandbox,
        () => appendTo(sandbox, "docs/AGENTS.md"),
        3,
      );
      expect(code).toBe(3);
      expect(record).toMatchObject({ status: "failed", exit: 3 });
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
      expect(printed).toEqual([
        changedLine("docs/AGENTS.md", "changed"),
        "LK DISPATCH alpha failed exit 3",
      ]);
    });

    it("ends failed and lists the path when the session cannot be started after the change", async () => {
      const sandbox = preparedSandbox();
      const printed: string[] = [];
      const deps = depsFor(printed, () => undefined, 0, {
        spawnSession: async () => {
          appendTo(sandbox, "docs/AGENTS.md");
          throw new Error("spawn exploded");
        },
      });
      await expect(
        dispatchRun(options, sandbox.root, { LK_ROLE: "controller" }, deps),
      ).rejects.toThrow("spawn exploded");
      const record = readRecord(sandbox, "alpha");
      expect(record).toMatchObject({ status: "failed", exit: 1 });
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
      expect(existsSync(lockPath(sandbox))).toBe(false);
    });
  });

  describe("a second snapshot that cannot be taken", () => {
    it.skipIf(isRoot)(
      "records checkError and exits 4 when the session exited 0 and the second snapshot cannot be taken",
      async () => {
        const sandbox = preparedSandbox();
        const unreadable = pathIn(sandbox, "docs/.git");
        let outcome: Outcome;
        try {
          outcome = await runSessionThat(sandbox, () => chmodSync(unreadable, 0o000));
        } finally {
          chmodSync(unreadable, 0o755);
        }
        const { code, record, printed } = outcome;
        expect(code).toBe(4);
        expect(record).toMatchObject({ status: "failed", exit: 4 });
        expect(record.checkError).toMatch(/^EACCES/);
        expect("changed" in record).toBe(false);
        expect(printed).toEqual([
          `LK PROTECTED PATH CHECK FAILED: ${record.checkError}`,
          "LK DISPATCH alpha failed exit 4",
        ]);
        expect(existsSync(lockPath(sandbox))).toBe(false);
      },
    );
  });

  describe("a run that cannot start", () => {
    const startedBy = (): { calls: string[]; deps: DispatchDeps } => {
      const calls: string[] = [];
      const deps = depsFor([], () => undefined, 0, {
        spawnSession: async () => {
          calls.push("session");
          return { exitCode: 0 };
        },
        runSmoke: () => {
          calls.push("smoke");
          return { status: 0, stdout: "ok", timedOut: false };
        },
      });
      return { calls, deps };
    };

    const expectNothingLeftBehind = (sandbox: Sandbox, calls: string[]): void => {
      expect(calls).toEqual([]);
      expect(existsSync(lockPath(sandbox))).toBe(false);
      expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
      expect(existsSync(join(sandbox.root, ".work/alpha/snapshot-before.json"))).toBe(false);
    };

    it("refuses before anything starts when docs/ is absent", async () => {
      const sandbox = preparedSandbox();
      realFs.rmSync(join(sandbox.root, "docs"), { recursive: true, force: true });
      const { calls, deps } = startedBy();
      await expect(
        dispatchRun({ ...options, noSmoke: false }, sandbox.root, { LK_ROLE: "controller" }, deps),
      ).rejects.toThrow(
        new LkRefusal(
          `${join(sandbox.root, "docs")} is absent or not a folder, the protected paths cannot be snapshotted`,
        ),
      );
      expectNothingLeftBehind(sandbox, calls);
    });

    it("prints one LK REFUSED line and exits 1 on the command line when docs/ is absent", () => {
      const sandbox = preparedSandbox();
      realFs.rmSync(join(sandbox.root, "docs"), { recursive: true, force: true });
      const result = run(sandbox, "alpha");
      expectRefused(result, "is absent or not a folder", sandbox, "alpha");
      expect(existsSync(lockPath(sandbox))).toBe(false);
    });

    it.skipIf(isRoot)(
      "refuses before anything starts when the first snapshot cannot be taken",
      async () => {
        const sandbox = preparedSandbox();
        const unreadable = pathIn(sandbox, "docs/.git");
        chmodSync(unreadable, 0o000);
        const { calls, deps } = startedBy();
        try {
          await expect(
            dispatchRun(
              { ...options, noSmoke: false },
              sandbox.root,
              { LK_ROLE: "controller" },
              deps,
            ),
          ).rejects.toThrow(/^cannot snapshot the protected paths: EACCES/);
        } finally {
          chmodSync(unreadable, 0o755);
        }
        expectNothingLeftBehind(sandbox, calls);
      },
    );
  });

  describe("through the real session runner and a fake claude that writes a protected file", () => {
    const writerBin = join(workspace, "bin-writer");
    mkdirSync(writerBin);
    writeFileSync(
      join(writerBin, "claude"),
      '#!/bin/sh\nprintf \'tampered\\n\' >> "$FAKE_TOUCH_FILE"\nexit "${FAKE_MAIN_EXIT:-0}"\n',
    );
    chmodSync(join(writerBin, "claude"), 0o755);

    const dispatchWritingTo = async (
      sandbox: Sandbox,
      touched: string,
      sessionExit: string,
    ): Promise<Outcome> => {
      const printed: string[] = [];
      const deps: DispatchDeps = {
        spawnSession: spawnSessionWithClaude,
        runSmoke: () => ({ status: 0, stdout: "ok", timedOut: false }),
        isProcessAlive,
        pid: process.pid,
        print: (line) => printed.push(line),
      };
      const env = dispatchEnv(sandbox, {
        LK_ROLE: "controller",
        PATH: `${writerBin}:${process.env.PATH ?? ""}`,
        FAKE_TOUCH_FILE: touched,
        FAKE_MAIN_EXIT: sessionExit,
      });
      const code = await dispatchRun(options, sandbox.root, env, deps);
      return { code, record: readRecord(sandbox, "alpha"), printed };
    };

    it("ends done when the session writes a file outside the protected set", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await dispatchWritingTo(sandbox, pathIn(sandbox, "note.txt"), "0");
      expect(readText(sandbox, "note.txt")).toBe("tampered\n");
      expect(code).toBe(0);
      expect(record).toMatchObject({ status: "done", exit: 0 });
    });

    it("ends failed with exit 4 when the session writes a protected file", async () => {
      const sandbox = preparedSandbox();
      const { code, record, printed } = await dispatchWritingTo(
        sandbox,
        pathIn(sandbox, "docs/AGENTS.md"),
        "0",
      );
      expect(readText(sandbox, "docs/AGENTS.md")).toBe(`${SEED_TEXT}tampered\n`);
      expect(code).toBe(4);
      expect(record).toMatchObject({ status: "failed", exit: 4 });
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
      expect(printed).toContain(changedLine("docs/AGENTS.md", "changed"));
    });

    it("ends failed with the session's exit 3 when the session writes a protected file and fails", async () => {
      const sandbox = preparedSandbox();
      const { code, record } = await dispatchWritingTo(
        sandbox,
        pathIn(sandbox, "docs/AGENTS.md"),
        "3",
      );
      expect(code).toBe(3);
      expect(record).toMatchObject({ status: "failed", exit: 3 });
      expect(record.changed).toEqual([{ path: "docs/AGENTS.md", change: "changed" }]);
    });
  });

  describe("the protected set", () => {
    const coversPath = (entry: string, path: string): boolean =>
      entry.endsWith("/") ? path.startsWith(entry) : path === entry;

    const uncoveredBy = (set: readonly string[]): string[] =>
      PROTECTED_PATHS.map(({ path }) => path).filter(
        (path) => !set.some((entry) => coversPath(entry, path)),
      );

    it("covers every path of PROTECTED_PATHS in protect-table.ts", () => {
      expect(uncoveredBy(PROTECTED_SET)).toEqual([]);
    });

    it("is checked by a pin that names the path a set leaves out", () => {
      const withoutAgents = PROTECTED_SET.filter((entry) => entry !== "docs/AGENTS.md");
      const withoutClaudeFolder = PROTECTED_SET.filter((entry) => entry !== "docs/.claude/");
      expect(uncoveredBy(withoutAgents)).toEqual(["docs/AGENTS.md"]);
      expect(uncoveredBy(withoutClaudeFolder)).toEqual([
        "docs/.claude/hooks/x.sh",
        "docs/.claude/settings.json",
      ]);
    });

    it("does not cover a path outside the protected list", () => {
      const outside = ["docs/project/open-debt.md", "docs/product/other.md", ".git/HEAD"];
      expect(
        outside.filter((path) => PROTECTED_SET.some((entry) => coversPath(entry, path))),
      ).toEqual([]);
    });
  });

  describe("the snapshot", () => {
    const scratchFolder = (): string => mkdtempSync(join(workspace, "snapshot-"));

    it("records a file with its permission bits and the sha256 of its bytes", () => {
      const root = scratchFolder();
      writeFileSync(join(root, "f.txt"), "abc");
      chmodSync(join(root, "f.txt"), 0o640);
      expect(snapshotProtectedPaths(root, ["f.txt"])).toEqual([
        { path: "f.txt", kind: "file", mode: 0o640, sha256: sha256Of("abc") },
      ]);
    });

    it("records a link with its target text and follows it neither as a file nor as a folder", () => {
      const root = scratchFolder();
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real/inside.txt"), "inside");
      symlinkSync("real", join(root, "link"));
      expect(snapshotProtectedPaths(root, ["link", "link/"])).toEqual([
        { path: "link", kind: "link", mode: expect.any(Number), target: "real" },
        { path: "link/", kind: "link", mode: expect.any(Number), target: "real" },
      ]);
    });

    it("records a folder and walks it in sorted order, nested folders included", () => {
      const root = scratchFolder();
      mkdirSync(join(root, "d/sub"), { recursive: true });
      for (const name of ["d/b.txt", "d/a.txt", "d/C.txt", "d/sub/z.txt", "d/sub/y.txt"]) {
        writeFileSync(join(root, name), name);
      }
      const entries = snapshotProtectedPaths(root, ["d/"]);
      expect(entries.map(({ path, kind }) => [path, kind])).toEqual([
        ["d/", "folder"],
        ["d/C.txt", "file"],
        ["d/a.txt", "file"],
        ["d/b.txt", "file"],
        ["d/sub", "folder"],
        ["d/sub/y.txt", "file"],
        ["d/sub/z.txt", "file"],
      ]);
    });

    it("records a path that does not exist as absent with no mode", () => {
      const root = scratchFolder();
      expect(snapshotProtectedPaths(root, ["missing.txt", "missing/"])).toEqual([
        { path: "missing.txt", kind: "absent" },
        { path: "missing/", kind: "absent" },
      ]);
    });

    it("counts a path whose parent is a file as absent", () => {
      const root = scratchFolder();
      writeFileSync(join(root, "parent"), "a file, not a folder");
      expect(snapshotProtectedPaths(root, ["parent/config", "parent/hooks/"])).toEqual([
        { path: "parent/config", kind: "absent" },
        { path: "parent/hooks/", kind: "absent" },
      ]);
    });

    it.skipIf(isRoot)("throws for a file it cannot read instead of calling it absent", () => {
      const root = scratchFolder();
      writeFileSync(join(root, "locked.txt"), "x");
      chmodSync(join(root, "locked.txt"), 0o000);
      try {
        expect(() => snapshotProtectedPaths(root, ["locked.txt"])).toThrow(/EACCES/);
      } finally {
        chmodSync(join(root, "locked.txt"), 0o644);
      }
    });

    it("walks every file of a folder, with no cap", () => {
      const root = scratchFolder();
      mkdirSync(join(root, "many"));
      for (let index = 0; index < 1_200; index += 1) {
        writeFileSync(join(root, "many", `f${index}.txt`), String(index));
      }
      expect(snapshotProtectedPaths(root, ["many/"])).toHaveLength(1_201);
    });

    it("refuses two spellings of a path that differ only in case", () => {
      const root = scratchFolder();
      writeFileSync(join(root, "a.txt"), "x");
      expect(() => snapshotProtectedPaths(root, ["a.txt", "A.txt"])).toThrow(
        "one path once case is folded",
      );
    });
  });

  describe("the difference between two snapshots", () => {
    const file = (path: string, sha256: string, mode = 0o644): SnapshotEntry => ({
      path,
      kind: "file",
      mode,
      sha256,
    });

    it("reports a path that was added, removed, changed or changed kind, one entry each", () => {
      const before: SnapshotEntry[] = [
        file("kept", "a"),
        file("edited", "a"),
        file("deleted", "a"),
        file("linked", "a"),
        { path: "created", kind: "absent" },
      ];
      const after: SnapshotEntry[] = [
        file("kept", "a"),
        file("edited", "b"),
        { path: "deleted", kind: "absent" },
        { path: "linked", kind: "link", mode: 0o755, target: "kept" },
        file("created", "a"),
      ];
      expect(diffSnapshots(before, after)).toEqual([
        { path: "edited", change: "changed" },
        { path: "deleted", change: "removed" },
        { path: "linked", change: "kind changed" },
        { path: "created", change: "added" },
      ]);
    });

    it("reports nothing for two equal snapshots", () => {
      const snapshot = [file("a", "a"), { path: "b/", kind: "folder" as const, mode: 0o755 }];
      expect(diffSnapshots(snapshot, snapshot)).toEqual([]);
    });

    it("reports a permission change as changed", () => {
      expect(diffSnapshots([file("a", "a", 0o644)], [file("a", "a", 0o600)])).toEqual([
        { path: "a", change: "changed" },
      ]);
    });

    it("reports a link whose target text changed as changed", () => {
      const link = (target: string): SnapshotEntry => ({
        path: "l",
        kind: "link",
        mode: 0o755,
        target,
      });
      expect(diffSnapshots([link("one")], [link("two")])).toEqual([
        { path: "l", change: "changed" },
      ]);
    });

    it("compares paths case-folded, so a case-only difference is no change and a content change is one", () => {
      expect(diffSnapshots([file("docs/AGENTS.md", "a")], [file("docs/agents.md", "a")])).toEqual(
        [],
      );
      expect(diffSnapshots([file("docs/AGENTS.md", "a")], [file("docs/agents.md", "b")])).toEqual([
        { path: "docs/agents.md", change: "changed" },
      ]);
    });
  });
});

describe("the deny list as data", () => {
  it("is the patterns joined by commas, in order", () => {
    expect(DENY_LIST).toBe(DENY_PATTERNS.join(","));
  });
});
