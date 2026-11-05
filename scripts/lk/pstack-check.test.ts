// @vitest-environment node

/**
 * The pstack check.
 *
 * Every fixture is synthetic: a register, a lock, a mode, a rule list, an installed copy and a home
 * folder written under a temporary folder. The cases build their inputs through the same exported
 * functions the runner calls (readInstalledPath, readInputs, buildCheckInputs, runChecks), so a
 * check that is not wired into runChecks fails here and not only in its own unit.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PstackRefusal,
  buildCheckInputs,
  checkLeak,
  countFailedChecks,
  exitCodeOf,
  formatRefusal,
  formatReport,
  hashTree,
  parseLock,
  parseRegister,
  readInputs,
  readInstalledPath,
  readRuleNumbers,
  runChecks,
  type CheckName,
  type CheckResult,
} from "./pstack-check";

const workspace = mkdtempSync(join(tmpdir(), "lk-pstack-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ---------------------------------------------------------------------------------------------
// The synthetic tree
// ---------------------------------------------------------------------------------------------

const TABLE_A_HEADING = "## Table A: pstack skills and agents";
const TABLE_A_HEADER = "| pstack item | Kind | Status | Authority | Lombakita counterpart | Note |";
const TABLE_B_HEADING = "## Table B: Lombakita rules of docs/CLAUDE.md";
const TABLE_B_HEADER = "| Rule | Bucket | Nearest pstack item | Origin |";
const TABLE_C_HEADING = "## Table C: Lombakita commands, agents, skills and hooks";
const TABLE_C_HEADER = "| Lombakita item | Kind | Bucket | Nearest pstack item | Note |";

const row = (...cells: string[]): string => `| ${cells.join(" | ")} |`;
const separator = (columns: number): string => `|${"---|".repeat(columns)}`;

const DEFAULT_INSTALLED_FILES: Record<string, string> = {
  "skills/alpha/SKILL.md": "---\nname: alpha\ndisable-model-invocation: true\n---\nalpha body\n",
  "skills/beta/SKILL.md": "---\nname: beta\n---\nbeta body\n",
  "agents/gamma.md": "gamma body\n",
  "README.md": "readme\n",
};

const DEFAULT_TABLE_A = [
  row("alpha", "skill", "ADOPT", "pstack", "none", "synthetic"),
  row("beta", "skill", "FORBIDDEN", "n/a", "none", ""),
  row("gamma", "agent", "NOT-USED", "n/a", "none", ""),
];

const DEFAULT_TABLE_B = [
  row("1", "G2", "none", "none"),
  row("2", "L", "none", "a synthetic failure"),
  row("3", "L", "none", "none"),
];

const DEFAULT_TABLE_C = [
  row("docs/.claude/commands/cmd-one.md", "command", "L", "none", ""),
  row("docs/.claude/agents/agent-one.md", "agent", "L", "none", ""),
  row("docs/.claude/skills/skill-one", "skill", "L", "none", ""),
  row("docs/.claude/skills/lombakita-mode", "skill", "L", "none", ""),
  row("docs/.claude/hooks/hook-one.sh", "hook", "L", "none", ""),
  row("user level: sample", "user skill", "G2", "none", ""),
];

const DEFAULT_CLAUDE_TEXT = [
  "# synthetic rule book",
  "",
  "## Implementation Rules",
  "",
  "1. first synthetic rule",
  "2. second synthetic rule",
  "   3. an indented numbered line is not a rule",
  "3. third synthetic rule",
  "",
  "## UI Level Defaults",
  "",
  "4. a numbered line after the end heading is not a rule",
  "",
].join("\n");

const DEFAULT_MODE_TEXT = "synthetic mode\n\n- Rule 2: a synthetic failure.\n";

const DEFAULT_PRODUCT_FILES: Record<string, string> = {
  "docs/.claude/commands/cmd-one.md": "command\n",
  "docs/.claude/commands/notes.txt": "not a command\n",
  "docs/.claude/commands/VENDORED-UI-SKILLS.md": "a list, not a command\n",
  "docs/.claude/agents/agent-one.md": "agent\n",
  "docs/.claude/skills/skill-one/SKILL.md": "skill\n",
  "docs/.claude/skills/VENDORED-UI-SKILLS.md": "a list, not a skill\n",
  "docs/.claude/hooks/hook-one.sh": "echo hook\n",
  "docs/.claude/hooks/proof/note.txt": "a folder, not a hook\n",
  "docs/.claude/hooks/.DS_Store": "noise\n",
};

const DEFAULT_HOME_FILES: Record<string, string> = {
  ".claude/CLAUDE.md": "a clean global file\n",
  ".claude/skills/clean-skill/SKILL.md": "a clean skill\n",
  ".codex/shared.md": "This shared file names Lombakita and is an allowed mention.\n",
};

interface FixtureOverrides {
  installedFiles?: Record<string, string>;
  tableA?: string[];
  tableB?: string[];
  tableC?: string[];
  mentions?: string[];
  registerText?: string;
  lockText?: string;
  claudeText?: string;
  modeText?: string;
  productFiles?: Record<string, string>;
  homeFiles?: Record<string, string>;
}

interface Fixture {
  productRoot: string;
  homeFolder: string;
  installedPath: string;
}

const sha256OfText = (text: string): string => createHash("sha256").update(text).digest("hex");

const writeFileDeep = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const writeFiles = (folder: string, files: Record<string, string>): void => {
  for (const [relativePath, text] of Object.entries(files)) {
    writeFileDeep(join(folder, relativePath), text);
  }
};

const lockTextOf = (files: Record<string, string>): string =>
  Object.entries(files)
    .map(([path, text]) => `${sha256OfText(text)}  ./${path}`)
    .join("\n") + "\n";

const registerTextOf = (parts: {
  tableA: string[];
  tableB: string[];
  tableC: string[];
  mentions: string[];
}): string =>
  [
    "# synthetic register",
    "",
    "## Allowed mentions of Lombakita at user level",
    "",
    "An introduction line that is not a mention.",
    "",
    ...parts.mentions.map((mention) => `- ${mention}`),
    "",
    TABLE_A_HEADING,
    "",
    TABLE_A_HEADER,
    separator(6),
    ...parts.tableA,
    "",
    TABLE_B_HEADING,
    "",
    TABLE_B_HEADER,
    separator(4),
    ...parts.tableB,
    "",
    TABLE_C_HEADING,
    "",
    TABLE_C_HEADER,
    separator(5),
    ...parts.tableC,
    "",
  ].join("\n");

const pluginsFileTextOf = (installedPath: string): string =>
  JSON.stringify({
    version: 2,
    plugins: {
      "other@elsewhere": [{ scope: "user", installPath: "/not/used" }],
      "pstack@cursor-plugins": [{ scope: "user", installPath: installedPath }],
    },
  });

let fixtureCount = 0;

const makeFixture = (overrides: FixtureOverrides = {}): Fixture => {
  fixtureCount += 1;
  const base = join(workspace, `case-${fixtureCount}`);
  const productRoot = join(base, "product");
  const homeFolder = join(base, "home");
  const installedPath = join(base, "installed");
  const installedFiles = overrides.installedFiles ?? DEFAULT_INSTALLED_FILES;

  writeFiles(installedPath, installedFiles);
  writeFiles(productRoot, { ...DEFAULT_PRODUCT_FILES, ...overrides.productFiles });
  writeFiles(productRoot, {
    "docs/project/pstack-policy.md":
      overrides.registerText ??
      registerTextOf({
        tableA: overrides.tableA ?? DEFAULT_TABLE_A,
        tableB: overrides.tableB ?? DEFAULT_TABLE_B,
        tableC: overrides.tableC ?? DEFAULT_TABLE_C,
        mentions: overrides.mentions ?? ["~/.codex/shared.md"],
      }),
    "docs/project/pstack-lock.sha256": overrides.lockText ?? lockTextOf(installedFiles),
    "docs/CLAUDE.md": overrides.claudeText ?? DEFAULT_CLAUDE_TEXT,
    "docs/.claude/skills/lombakita-mode/SKILL.md": overrides.modeText ?? DEFAULT_MODE_TEXT,
  });
  writeFiles(homeFolder, { ...DEFAULT_HOME_FILES, ...overrides.homeFiles });
  writeFileDeep(
    join(homeFolder, ".claude/plugins/installed_plugins.json"),
    pluginsFileTextOf(installedPath),
  );
  return { productRoot, homeFolder, installedPath };
};

/** The runner's own chain, minus printing and the exit code. */
const runFixture = (fixture: Fixture): CheckResult[] => {
  const installedPath = readInstalledPath(fixture.homeFolder);
  const rawInputs = readInputs(fixture.productRoot);
  return runChecks(buildCheckInputs(rawInputs, installedPath, fixture.homeFolder));
};

const failuresOf = (fixture: Fixture, name: CheckName): string[] => {
  const result = runFixture(fixture).find((candidate) => candidate.name === name);
  expect(result).toBeDefined();
  return result!.failures;
};

const refusalOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PstackRefusal);
    return (error as PstackRefusal).message;
  }
  throw new Error("expected a PstackRefusal and nothing was thrown");
};

// ---------------------------------------------------------------------------------------------
// The six checks
// ---------------------------------------------------------------------------------------------

describe("runChecks", () => {
  it("returns the six checks in the order drift, unclassified, pointer, flag, failure-born, leak", () => {
    const names = runFixture(makeFixture()).map((result) => result.name);
    expect(names).toEqual(["drift", "unclassified", "pointer", "flag", "failure-born", "leak"]);
  });

  it("passes every check on a synthetic tree that agrees with itself", () => {
    const results = runFixture(makeFixture());
    expect(results.map((result) => result.failures)).toEqual([[], [], [], [], [], []]);
    expect(formatReport(results).at(-1)).toBe("verify:pstack PASSED");
    expect(exitCodeOf(countFailedChecks(results))).toBe(0);
  });
});

describe("drift", () => {
  it("names a changed, an added and a removed file, marking the ones below an ADOPT skill", () => {
    const fixture = makeFixture();
    writeFileDeep(join(fixture.installedPath, "skills/alpha/SKILL.md"), "changed\n");
    writeFileDeep(join(fixture.installedPath, "skills/beta/SKILL.md"), "changed\n");
    writeFileDeep(join(fixture.installedPath, "skills/alpha/extra.md"), "new\n");
    writeFileDeep(join(fixture.installedPath, "new.txt"), "new\n");
    rmSync(join(fixture.installedPath, "README.md"));

    expect(failuresOf(fixture, "drift")).toEqual([
      "added: ./new.txt",
      "added: ./skills/alpha/extra.md (referenced)",
      "changed: ./skills/alpha/SKILL.md (referenced)",
      "changed: ./skills/beta/SKILL.md",
      "removed: ./README.md",
    ]);
  });

  it("skips a non-empty .in_use folder at the root of the installed copy", () => {
    const fixture = makeFixture();
    writeFileDeep(join(fixture.installedPath, ".in_use/4242.pid"), "4242\n");

    expect(failuresOf(fixture, "drift")).toEqual([]);
    expect(
      [...hashTree(fixture.installedPath).keys()].some((path) => path.includes(".in_use")),
    ).toBe(false);
  });

  it("skips an empty .in_use folder at the root of the installed copy", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.installedPath, ".in_use"));

    expect(failuresOf(fixture, "drift")).toEqual([]);
  });

  it("does not skip a .in_use folder below the root", () => {
    const fixture = makeFixture();
    writeFileDeep(join(fixture.installedPath, "skills/alpha/.in_use/4242.pid"), "4242\n");

    expect(failuresOf(fixture, "drift")).toEqual([
      "added: ./skills/alpha/.in_use/4242.pid (referenced)",
    ]);
  });
});

describe("unclassified", () => {
  it("names a pstack skill that has no row", () => {
    const fixture = makeFixture({
      tableA: DEFAULT_TABLE_A.filter((line) => !line.includes("beta")),
    });
    expect(failuresOf(fixture, "unclassified")).toEqual(["pstack skill without a row: beta"]);
  });

  it("names a pstack agent that has no row", () => {
    const fixture = makeFixture({
      tableA: DEFAULT_TABLE_A.filter((line) => !line.includes("gamma")),
    });
    expect(failuresOf(fixture, "unclassified")).toEqual(["pstack agent without a row: gamma"]);
  });

  it("names a rule that has no row", () => {
    const fixture = makeFixture({ tableB: DEFAULT_TABLE_B.slice(0, 2) });
    expect(failuresOf(fixture, "unclassified")).toEqual(["rule without a row: 3"]);
  });

  it("names a rule row beyond the last rule", () => {
    const fixture = makeFixture({ tableB: [...DEFAULT_TABLE_B, row("9", "L", "none", "none")] });
    expect(failuresOf(fixture, "unclassified")).toEqual(["rule row beyond the last rule: 9"]);
  });

  it("names a Lombakita item that has no row", () => {
    const fixture = makeFixture({
      productFiles: { "docs/.claude/commands/extra.md": "command\n" },
    });
    expect(failuresOf(fixture, "unclassified")).toEqual([
      "Lombakita item without a row: docs/.claude/commands/extra.md",
    ]);
  });

  it("names a row for a Lombakita item that does not exist, and exempts a user level row", () => {
    const fixture = makeFixture({
      tableC: [...DEFAULT_TABLE_C, row("docs/.claude/hooks/ghost.sh", "hook", "L", "none", "")],
    });
    expect(failuresOf(fixture, "unclassified")).toEqual([
      "row for a Lombakita item that does not exist: docs/.claude/hooks/ghost.sh",
    ]);
  });

  it("sorts its failure lines by their text", () => {
    const fixture = makeFixture({
      tableA: DEFAULT_TABLE_A.filter((line) => !line.includes("beta") && !line.includes("gamma")),
      tableB: DEFAULT_TABLE_B.slice(0, 2),
    });
    expect(failuresOf(fixture, "unclassified")).toEqual([
      "pstack agent without a row: gamma",
      "pstack skill without a row: beta",
      "rule without a row: 3",
    ]);
  });
});

describe("pointer", () => {
  it("names a registered skill and a registered agent that are not installed", () => {
    const fixture = makeFixture({
      tableA: [
        ...DEFAULT_TABLE_A,
        row("delta", "skill", "PARKED", "n/a", "none", ""),
        row("epsilon", "agent", "PARKED", "n/a", "none", ""),
      ],
    });
    expect(failuresOf(fixture, "pointer")).toEqual([
      "register names a pstack agent that is not installed: epsilon",
      "register names a pstack skill that is not installed: delta",
    ]);
  });
});

describe("flag", () => {
  it.each([
    { name: "no such line", alpha: "---\nname: alpha\n---\nbody\n" },
    {
      name: "the line only in the body",
      alpha: "---\nname: alpha\n---\ndisable-model-invocation: true\n",
    },
    {
      name: "the line set to false",
      alpha: "---\nname: alpha\ndisable-model-invocation: false\n---\nbody\n",
    },
  ])("names a skill whose frontmatter has $name", ({ alpha }) => {
    const fixture = makeFixture({
      installedFiles: { ...DEFAULT_INSTALLED_FILES, "skills/alpha/SKILL.md": alpha },
    });
    expect(failuresOf(fixture, "flag")).toEqual([
      "skill is model-invocable and not FORBIDDEN: alpha",
    ]);
  });

  it("names a model-invocable skill that has no row", () => {
    const fixture = makeFixture({
      installedFiles: {
        ...DEFAULT_INSTALLED_FILES,
        "skills/zeta/SKILL.md": "---\nname: zeta\n---\n",
      },
    });
    expect(failuresOf(fixture, "flag")).toEqual([
      "skill is model-invocable and not FORBIDDEN: zeta",
    ]);
  });
});

describe("failure-born", () => {
  it("names a rule with an origin that the mode does not name", () => {
    const fixture = makeFixture({ modeText: "synthetic mode that names no rule\n" });
    expect(failuresOf(fixture, "failure-born")).toEqual([
      "rule 2 has an origin and the mode does not name Rule 2",
    ]);
  });

  it("does not take Rule 20 for Rule 2", () => {
    const fixture = makeFixture({ modeText: "Rule 20 is named here\n" });
    expect(failuresOf(fixture, "failure-born")).toEqual([
      "rule 2 has an origin and the mode does not name Rule 2",
    ]);
  });

  it("finds Rule 2 after an earlier Rule 20, and at the very end of the text", () => {
    const fixture = makeFixture({ modeText: "Rule 20 first, then Rule 2" });
    expect(failuresOf(fixture, "failure-born")).toEqual([]);
  });
});

describe("leak", () => {
  it("names a new file under the skills folder that holds the word in any case", () => {
    const fixture = makeFixture({
      homeFiles: {
        ".claude/skills/leaky/notes.md": "this note says LOMBAKITA once\n",
        ".claude/settings.json": '{"note": "lombakita"}\n',
      },
    });
    expect(failuresOf(fixture, "leak")).toEqual([
      "~/.claude/settings.json names Lombakita and is not an allowed mention",
      "~/.claude/skills/leaky/notes.md names Lombakita and is not an allowed mention",
    ]);
  });

  it("allows the mentions the register lists, written with or without ~/", () => {
    const fixture = makeFixture({ mentions: [] });
    expect(failuresOf(fixture, "leak")).toEqual([
      "~/.codex/shared.md names Lombakita and is not an allowed mention",
    ]);
    const absolute = join(fixture.homeFolder, ".codex/shared.md");
    expect(checkLeak(fixture.homeFolder, [absolute])).toEqual([]);
  });

  it("does not follow a link, and skips a location that does not exist", () => {
    const fixture = makeFixture();
    const target = join(fixture.homeFolder, "elsewhere.txt");
    writeFileDeep(target, "lombakita\n");
    mkdirSync(join(fixture.homeFolder, ".claude/commands"), { recursive: true });
    symlinkSync(target, join(fixture.homeFolder, ".claude/commands/linked.md"));

    expect(failuresOf(fixture, "leak")).toEqual([]);
  });

  it.skipIf(isRoot)("names a declared location that exists and cannot be read", () => {
    const fixture = makeFixture({
      homeFiles: { ".claude/claude-only.md": "clean\n", ".claude/rules/one.md": "clean\n" },
    });
    const lockedFile = join(fixture.homeFolder, ".claude/claude-only.md");
    const lockedFolder = join(fixture.homeFolder, ".claude/rules");
    try {
      chmodSync(lockedFile, 0o000);
      chmodSync(lockedFolder, 0o000);
      expect(failuresOf(fixture, "leak")).toEqual([
        "location unreadable: ~/.claude/claude-only.md",
        "location unreadable: ~/.claude/rules",
      ]);
    } finally {
      chmodSync(lockedFile, 0o644);
      chmodSync(lockedFolder, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The refusals, one test each, each asserting its own fixed text
// ---------------------------------------------------------------------------------------------

describe("refusals", () => {
  it("refuses when installed_plugins.json is missing or has no pstack entry", () => {
    const fixture = makeFixture();
    const pluginsFile = join(fixture.homeFolder, ".claude/plugins/installed_plugins.json");
    const reason = "installed_plugins.json is missing or has no pstack@cursor-plugins entry";

    writeFileSync(pluginsFile, '{"plugins": {}}');
    expect(refusalOf(() => readInstalledPath(fixture.homeFolder))).toBe(reason);
    writeFileSync(pluginsFile, "not json");
    expect(refusalOf(() => readInstalledPath(fixture.homeFolder))).toBe(reason);
    rmSync(pluginsFile);
    expect(refusalOf(() => readInstalledPath(fixture.homeFolder))).toBe(reason);
  });

  it("refuses when installPath is not a folder", () => {
    const fixture = makeFixture();
    const notAFolder = join(fixture.homeFolder, "no-such-folder");
    writeFileSync(
      join(fixture.homeFolder, ".claude/plugins/installed_plugins.json"),
      pluginsFileTextOf(notAFolder),
    );

    expect(refusalOf(() => readInstalledPath(fixture.homeFolder))).toBe(
      `installPath is not a folder: ${notAFolder}`,
    );
  });

  it("refuses when an input file is missing", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.productRoot, "docs/project/pstack-lock.sha256"));

    expect(refusalOf(() => readInputs(fixture.productRoot))).toBe(
      "input file missing: docs/project/pstack-lock.sha256",
    );
  });

  it("refuses when a table is missing or its header row is not exact", () => {
    const withoutTableC = registerTextOf({
      tableA: DEFAULT_TABLE_A,
      tableB: DEFAULT_TABLE_B,
      tableC: DEFAULT_TABLE_C,
      mentions: [],
    })
      .split("\n")
      .filter((line) => line !== TABLE_C_HEADING)
      .join("\n");
    const renamedHeader = registerTextOf({
      tableA: DEFAULT_TABLE_A,
      tableB: DEFAULT_TABLE_B,
      tableC: DEFAULT_TABLE_C,
      mentions: [],
    }).replace(TABLE_B_HEADER, "| Rule | Bucket | Nearest | Origin |");

    expect(refusalOf(() => runFixture(makeFixture({ registerText: withoutTableC })))).toBe(
      `table missing: ${TABLE_C_HEADING}`,
    );
    expect(refusalOf(() => runFixture(makeFixture({ registerText: renamedHeader })))).toBe(
      `table missing: ${TABLE_B_HEADING}`,
    );
  });

  it("refuses a row with the wrong number of cells", () => {
    const fixture = makeFixture({ tableB: [...DEFAULT_TABLE_B, row("4", "L", "none")] });

    expect(refusalOf(() => runFixture(fixture))).toBe(
      `row with the wrong number of cells in ${TABLE_B_HEADING}: 4`,
    );
  });

  it("refuses a value outside its allowed set", () => {
    const fixture = makeFixture({
      tableA: [...DEFAULT_TABLE_A, row("delta", "skill", "MAYBE", "n/a", "none", "")],
    });

    expect(refusalOf(() => runFixture(fixture))).toBe(
      `value outside its allowed set in ${TABLE_A_HEADING}: MAYBE`,
    );
  });

  it("refuses a repeated key", () => {
    const fixture = makeFixture({
      tableA: [...DEFAULT_TABLE_A, row("alpha", "skill", "PARKED", "n/a", "none", "")],
    });

    expect(refusalOf(() => runFixture(fixture))).toBe(`repeated key in ${TABLE_A_HEADING}: alpha`);
  });

  it("refuses a lock line that is not in the lock format, naming its line number", () => {
    const goodLine = `${sha256OfText("x")}  ./one.txt`;
    const lockWith = (...lines: string[]) => lines.join("\n") + "\n";
    const refusalFor = (lockText: string) => refusalOf(() => runFixture(makeFixture({ lockText })));

    expect(refusalFor(lockWith(goodLine, "not a lock line"))).toBe(
      "lock line not in the lock format: 2",
    );
    expect(refusalFor(lockWith(goodLine, `${sha256OfText("y").slice(1)}  ./two.txt`))).toBe(
      "lock line not in the lock format: 2",
    );
    expect(refusalFor(lockWith(goodLine, `${sha256OfText("y")} ./two.txt`))).toBe(
      "lock line not in the lock format: 2",
    );
    expect(refusalFor(lockWith(goodLine, `${sha256OfText("y")}  two.txt`))).toBe(
      "lock line not in the lock format: 2",
    );
    expect(refusalFor(lockWith(goodLine, goodLine))).toBe("lock line not in the lock format: 2");
  });

  it("refuses an entry that is neither a regular file nor a folder", () => {
    const fixture = makeFixture();
    const link = join(fixture.installedPath, "linked.md");
    symlinkSync(join(fixture.installedPath, "README.md"), link);

    expect(refusalOf(() => runFixture(fixture))).toBe(
      `entry that is neither a regular file nor a folder: ${link}`,
    );
  });

  it.skipIf(isRoot)("refuses an unreadable path below a declared location", () => {
    const fixture = makeFixture({
      homeFiles: {
        ".claude/skills/locked/secret.md": "clean\n",
        ".claude/skills/closed/inner.md": "clean\n",
      },
    });
    const lockedFile = join(fixture.homeFolder, ".claude/skills/locked/secret.md");
    const lockedFolder = join(fixture.homeFolder, ".claude/skills/closed");
    const installedFile = join(fixture.installedPath, "README.md");
    const reason = "unreadable path below a declared location: ";
    try {
      chmodSync(lockedFile, 0o000);
      expect(refusalOf(() => checkLeak(fixture.homeFolder, []))).toBe(`${reason}${lockedFile}`);
      chmodSync(lockedFile, 0o644);

      chmodSync(lockedFolder, 0o000);
      expect(refusalOf(() => checkLeak(fixture.homeFolder, []))).toBe(`${reason}${lockedFolder}`);

      chmodSync(installedFile, 0o000);
      expect(refusalOf(() => hashTree(fixture.installedPath))).toBe(`${reason}${installedFile}`);
    } finally {
      chmodSync(lockedFile, 0o644);
      chmodSync(lockedFolder, 0o755);
      chmodSync(installedFile, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------------------------

describe("output", () => {
  const passing = (name: CheckName): CheckResult => ({ name, failures: [] });

  it("prints a PASS or FAIL line per check, each failure indented under its check, then the verdict", () => {
    const manyFailures = Array.from({ length: 30 }, (_, index) => `added: ./file-${index}`);
    const results: CheckResult[] = [
      { name: "drift", failures: ["changed: ./a (referenced)", "removed: ./b"] },
      passing("unclassified"),
      passing("pointer"),
      { name: "flag", failures: manyFailures },
      passing("failure-born"),
      passing("leak"),
    ];

    expect(formatReport(results)).toEqual([
      "FAIL drift",
      "  - changed: ./a (referenced)",
      "  - removed: ./b",
      "PASS unclassified",
      "PASS pointer",
      "FAIL flag",
      ...manyFailures.map((failure) => `  - ${failure}`),
      "PASS failure-born",
      "PASS leak",
      "verify:pstack FAILED (2 checks failed)",
    ]);
  });

  it("ends a clean report with the PASSED line", () => {
    const names: CheckName[] = ["drift", "unclassified", "pointer", "flag", "failure-born", "leak"];

    expect(formatReport(names.map(passing))).toEqual([
      "PASS drift",
      "PASS unclassified",
      "PASS pointer",
      "PASS flag",
      "PASS failure-born",
      "PASS leak",
      "verify:pstack PASSED",
    ]);
  });

  it("formats a refusal as one REFUSED line", () => {
    expect(formatRefusal("table missing: ## Table A")).toBe(
      "verify:pstack REFUSED: table missing: ## Table A",
    );
  });

  it("exits 0 for no failed check and 1 for any", () => {
    expect(exitCodeOf(0)).toBe(0);
    expect(exitCodeOf(1)).toBe(1);
    expect(exitCodeOf(6)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The real register, lock, rule list and mode, read through process.cwd() as the runner reads them.
// None of these asserts anything about the installed plugin or the home folder.
// ---------------------------------------------------------------------------------------------

const readDocFile = (relativePath: string): string => {
  try {
    return readFileSync(resolve(process.cwd(), relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `${relativePath} is not readable: the doc lane (\`docs/\`, a separate private checkout) is ` +
        `not present here.`,
    );
  }
};

const REAL_REGISTER_PATH = "docs/project/pstack-policy.md";
const REAL_LOCK_PATH = "docs/project/pstack-lock.sha256";
const REAL_CLAUDE_PATH = "docs/CLAUDE.md";
const REAL_MODE_PATH = "docs/.claude/skills/lombakita-mode/SKILL.md";

describe("the real files", () => {
  it("parses the register without a refusal and finds rows in every table", () => {
    const register = parseRegister(readDocFile(REAL_REGISTER_PATH));

    expect(register.pstackItems.length).toBeGreaterThan(0);
    expect(register.rules.length).toBeGreaterThan(0);
    expect(register.lombakitaItems.length).toBeGreaterThan(0);
    expect(register.allowedMentions.length).toBeGreaterThan(0);
  });

  it("lists in Table A the same skills and agents the lock lists", () => {
    const lockLines = readDocFile(REAL_LOCK_PATH).split("\n");
    const namesFromLock = (pattern: RegExp): string[] =>
      lockLines.flatMap((line) => pattern.exec(line)?.[1] ?? []).sort();
    const register = parseRegister(readDocFile(REAL_REGISTER_PATH));
    const namesInTableA = (kind: string): string[] =>
      register.pstackItems
        .filter((item) => item.kind === kind)
        .map((item) => item.name)
        .sort();

    const lockedSkills = namesFromLock(/^[0-9a-f]{64} {2}\.\/skills\/([^/]+)\/SKILL\.md$/);
    const lockedAgents = namesFromLock(/^[0-9a-f]{64} {2}\.\/agents\/([^/]+)\.md$/);

    expect(lockedSkills.length).toBeGreaterThan(0);
    expect(namesInTableA("skill")).toEqual(lockedSkills);
    expect(namesInTableA("agent")).toEqual(lockedAgents);
  });

  it("gives every rule of the rule book a row in Table B", () => {
    const claudeText = readDocFile(REAL_CLAUDE_PATH);
    const lines = claudeText.split("\n");
    const startAt = lines.indexOf("## Implementation Rules");
    const endAt = lines.indexOf("## UI Level Defaults");
    const ruleNumbers = lines
      .slice(startAt + 1, endAt)
      .flatMap((line) => /^(\d+)\. /.exec(line)?.[1] ?? []);
    const register = parseRegister(readDocFile(REAL_REGISTER_PATH));

    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(startAt);
    expect(ruleNumbers.length).toBeGreaterThan(0);
    expect(readRuleNumbers(claudeText)).toEqual(ruleNumbers);
    for (const rule of ruleNumbers) {
      expect(
        register.rules.some((candidate) => candidate.rule === rule),
        `rule ${rule} has no row in Table B`,
      ).toBe(true);
    }
  });

  it("has the mode name Rule N for every Table B row that has an origin", () => {
    const modeText = readDocFile(REAL_MODE_PATH);
    const register = parseRegister(readDocFile(REAL_REGISTER_PATH));
    const rowsWithOrigin = register.rules.filter((candidate) => candidate.origin !== "none");

    expect(rowsWithOrigin.length).toBeGreaterThan(0);
    for (const { rule } of rowsWithOrigin) {
      expect(
        new RegExp(`Rule ${rule}(?![0-9])`).test(modeText),
        `the mode does not name Rule ${rule}`,
      ).toBe(true);
    }
  });
});

describe("parseLock", () => {
  it("reads an uppercase hash as the same hash in lowercase, and accepts a missing final newline", () => {
    const hash = sha256OfText("x");
    const lock = parseLock(`${hash.toUpperCase()}  ./one.txt\n${hash}  ./two.txt`);

    expect([...lock.entries()]).toEqual([
      ["./one.txt", hash],
      ["./two.txt", hash],
    ]);
  });
});
