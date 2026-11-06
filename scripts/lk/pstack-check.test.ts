// @vitest-environment node

/**
 * The pstack check.
 *
 * Every fixture is synthetic: a config, a pairings list, a settings file, a mode, a rule list, an
 * installed copy, agent and command files and a home folder written under a temporary folder. The
 * cases build their inputs through the same exported functions the runner calls (readInstalledPath,
 * readInputs, buildCheckInputs, runChecks), so a check that is not wired into runChecks fails here
 * and not only in its own unit.
 */

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
  checkBoundary,
  checkDeny,
  checkLeak,
  checkMode,
  countFailedChecks,
  exitCodeOf,
  formatRefusal,
  formatReport,
  parseConfig,
  parsePairings,
  parseSettingsDeny,
  readInputs,
  readInstalledItems,
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

type ItemJson = Record<string, unknown>;

const item = (
  name: string,
  kind: "skill" | "agent",
  verdict: "use" | "watch" | "disabled",
  hard = false,
): ItemJson => ({ name, kind, verdict, hard });

const DEFAULT_ITEMS: ItemJson[] = [
  item("alpha", "skill", "use"),
  item("beta", "skill", "disabled", true),
  item("gamma", "agent", "watch"),
];

const DEFAULT_RULES = ["2"];
const DEFAULT_MENTIONS = ["~/.codex/shared.md"];
const DEFAULT_PAIRINGS_TEXT = "# synthetic pairings\n\nagent-one: alpha\n";
const DEFAULT_DENY_ENTRIES = ["Read(./.env)", "Skill(pstack:beta)"];

const DEFAULT_INSTALLED_FILES: Record<string, string> = {
  "skills/alpha/SKILL.md": "---\nname: alpha\ndisable-model-invocation: true\n---\nalpha body\n",
  "skills/beta/SKILL.md": "---\nname: beta\n---\nbeta body\n",
  "agents/gamma.md": "gamma body\n",
};

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

const DEFAULT_MODE_TEXT = "synthetic mode\n\nNever run beta.\n\n- Rule 2: a synthetic failure.\n";

const DEFAULT_PRODUCT_FILES: Record<string, string> = {
  "docs/.claude/commands/cmd-one.md": "command\n",
  "docs/.claude/agents/agent-one.md": "agent\n",
};

const DEFAULT_HOME_FILES: Record<string, string> = {
  ".claude/CLAUDE.md": "a clean global file\n",
  ".claude/skills/clean-skill/SKILL.md": "a clean skill\n",
  ".codex/shared.md": "This shared file names Lombakita and is an allowed mention.\n",
};

interface FixtureOverrides {
  installedFiles?: Record<string, string>;
  items?: ItemJson[];
  failureBornRules?: string[];
  mentions?: string[];
  configText?: string;
  pairingsText?: string;
  denyEntries?: string[];
  settingsText?: string;
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

const writeFileDeep = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const writeFiles = (folder: string, files: Record<string, string>): void => {
  for (const [relativePath, text] of Object.entries(files)) {
    writeFileDeep(join(folder, relativePath), text);
  }
};

/** A key whose change is `undefined` is left out of the text, which is how a test drops a key. */
const configTextOf = (changes: Record<string, unknown> = {}): string =>
  JSON.stringify({
    items: DEFAULT_ITEMS,
    failureBornRules: DEFAULT_RULES,
    allowedMentions: DEFAULT_MENTIONS,
    ...changes,
  });

const settingsTextOf = (denyEntries: string[]): string =>
  JSON.stringify({ hooks: {}, permissions: { deny: denyEntries } });

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

  writeFiles(installedPath, overrides.installedFiles ?? DEFAULT_INSTALLED_FILES);
  writeFiles(productRoot, { ...DEFAULT_PRODUCT_FILES, ...overrides.productFiles });
  writeFiles(productRoot, {
    "docs/.claude/pstack/config.json":
      overrides.configText ??
      configTextOf({
        items: overrides.items ?? DEFAULT_ITEMS,
        failureBornRules: overrides.failureBornRules ?? DEFAULT_RULES,
        allowedMentions: overrides.mentions ?? DEFAULT_MENTIONS,
      }),
    "docs/.claude/pstack/pairings": overrides.pairingsText ?? DEFAULT_PAIRINGS_TEXT,
    "docs/.claude/settings.json":
      overrides.settingsText ?? settingsTextOf(overrides.denyEntries ?? DEFAULT_DENY_ENTRIES),
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
// The seven checks
// ---------------------------------------------------------------------------------------------

describe("runChecks", () => {
  it("returns the seven checks in the order unscreened, flag, deny, pairings, boundary, mode, leak", () => {
    const names = runFixture(makeFixture()).map((result) => result.name);
    expect(names).toEqual(["unscreened", "flag", "deny", "pairings", "boundary", "mode", "leak"]);
  });

  it("passes every check on a synthetic tree that agrees with itself", () => {
    const results = runFixture(makeFixture());
    expect(results.map((result) => result.failures)).toEqual([[], [], [], [], [], [], []]);
    expect(formatReport(results).at(-1)).toBe("verify:pstack PASSED");
    expect(exitCodeOf(countFailedChecks(results))).toBe(0);
  });
});

describe("unscreened", () => {
  it("passes when every installed skill and agent has a config item of its kind and every item is installed", () => {
    expect(failuresOf(makeFixture(), "unscreened")).toEqual([]);
  });

  it("names an unscreened skill, an unscreened agent and a screened item that is not installed", () => {
    const fixture = makeFixture({
      installedFiles: {
        ...DEFAULT_INSTALLED_FILES,
        "skills/zeta/SKILL.md": "---\nname: zeta\n---\n",
        "agents/eta.md": "eta body\n",
      },
      items: [...DEFAULT_ITEMS, item("theta", "skill", "watch")],
    });

    expect(failuresOf(fixture, "unscreened")).toEqual([
      "pstack agent not screened: eta",
      "pstack skill not screened: zeta",
      "screened item is not installed: skill theta",
    ]);
  });

  it("takes the kind as part of the identity of an item", () => {
    const fixture = makeFixture({
      items: [item("alpha", "agent", "watch"), ...DEFAULT_ITEMS.slice(1)],
    });

    expect(failuresOf(fixture, "unscreened")).toEqual([
      "pstack skill not screened: alpha",
      "screened item is not installed: agent alpha",
    ]);
  });
});

describe("flag", () => {
  it("passes when every model-invocable skill is disabled in the config", () => {
    const fixture = makeFixture();
    const beta = readInstalledItems(fixture.installedPath).skills.find(
      (skill) => skill.name === "beta",
    );

    expect(beta?.modelInvocable).toBe(true);
    expect(failuresOf(fixture, "flag")).toEqual([]);
  });

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
      "skill is model-invocable and not disabled: alpha",
    ]);
  });

  it("names a model-invocable skill that has no config item and one whose verdict is watch", () => {
    const fixture = makeFixture({
      installedFiles: {
        ...DEFAULT_INSTALLED_FILES,
        "skills/zeta/SKILL.md": "---\nname: zeta\n---\n",
      },
      items: [
        item("alpha", "skill", "use"),
        item("beta", "skill", "watch"),
        item("gamma", "agent", "watch"),
      ],
    });

    expect(failuresOf(fixture, "flag")).toEqual([
      "skill is model-invocable and not disabled: beta",
      "skill is model-invocable and not disabled: zeta",
    ]);
  });
});

describe("deny", () => {
  it("passes when each hard item has its deny entry, in the agent form and in the skill form", () => {
    const fixture = makeFixture({
      items: [item("beta", "skill", "disabled", true), item("gamma", "agent", "disabled", true)],
      denyEntries: [
        "Read(./.env)",
        "Skill(other:alpha)",
        "Agent(pstack:gamma)",
        "Skill(pstack:beta)",
      ],
    });

    expect(failuresOf(fixture, "deny")).toEqual([]);
  });

  it("names a hard item without its deny entry and a deny entry without a hard item", () => {
    const fixture = makeFixture({
      items: [item("beta", "skill", "disabled", true), item("gamma", "agent", "disabled", true)],
      denyEntries: [
        "Agent(pstack:beta)",
        "Skill(pstack:gamma)",
        "Skill(pstack:zeta)",
        "Bash(ls*)",
        "Read(./.env)",
      ],
    });

    expect(failuresOf(fixture, "deny")).toEqual([
      "deny entry without a hard item: Agent(pstack:beta)",
      "deny entry without a hard item: Skill(pstack:gamma)",
      "deny entry without a hard item: Skill(pstack:zeta)",
      "hard item without a deny entry: agent gamma",
      "hard item without a deny entry: skill beta",
    ]);
  });
});

describe("pairings", () => {
  const withZeta = {
    ...DEFAULT_INSTALLED_FILES,
    "skills/zeta/SKILL.md": "---\nname: zeta\n---\n",
  };

  it("passes when every paired agent exists and every paired skill is installed, screened and not disabled", () => {
    expect(failuresOf(makeFixture(), "pairings")).toEqual([]);
  });

  it("names a pairing by its first defect, in the order of the file", () => {
    const fixture = makeFixture({
      installedFiles: withZeta,
      productFiles: { "docs/.claude/agents/sub/nested-agent.md": "nested\n" },
      pairingsText: [
        "# a comment line",
        "agent-one: nowhere",
        "",
        "agent-one: zeta",
        "agent-one: beta",
        "missing-agent: alpha",
        "lost-agent: nowhere",
        "nested-agent: alpha",
        "agent-one: alpha",
      ].join("\n"),
    });

    expect(failuresOf(fixture, "pairings")).toEqual([
      "paired skill is not installed: nowhere",
      "paired skill is not screened: zeta",
      "paired skill is disabled: beta",
      "paired agent does not exist: missing-agent",
      "paired agent does not exist: lost-agent",
      "paired agent does not exist: nested-agent",
    ]);
  });

  it("gives the line of the agent only when the agent does not exist and the skill is not installed", () => {
    const fixture = makeFixture({ pairingsText: "lost-agent: nowhere\n" });

    expect(failuresOf(fixture, "pairings")).toEqual(["paired agent does not exist: lost-agent"]);
  });

  it("returns its lines in the order of the file and does not sort them", () => {
    const fixture = makeFixture({ pairingsText: "agent-one: zz-missing\nagent-one: aa-missing\n" });

    expect(failuresOf(fixture, "pairings")).toEqual([
      "paired skill is not installed: zz-missing",
      "paired skill is not installed: aa-missing",
    ]);
  });
});

describe("boundary", () => {
  it("passes when the word is in a file that is not .md or in a subfolder, which are not read", () => {
    const fixture = makeFixture({
      productFiles: {
        "docs/.claude/agents/notes.txt": "pstack in a text file\n",
        "docs/.claude/agents/sub/deep.md": "pstack in a subfolder\n",
        "docs/.claude/commands/notes.txt": "pstack in a text file\n",
        "docs/.claude/commands/sub/deep.md": "pstack in a subfolder\n",
      },
    });

    expect(failuresOf(fixture, "boundary")).toEqual([]);
  });

  it("names a .md file of either folder that holds the word in any letter case", () => {
    const fixture = makeFixture({
      productFiles: {
        "docs/.claude/agents/agent-two.md": "This agent writes PSTACK once.\n",
        "docs/.claude/commands/cmd-two.md": "A Pstack mention.\n",
        "docs/.claude/agents/notes.txt": "pstack in a text file\n",
        "docs/.claude/agents/sub/deep.md": "pstack in a subfolder\n",
      },
    });

    expect(failuresOf(fixture, "boundary")).toEqual([
      "docs/.claude/agents/agent-two.md names pstack",
      "docs/.claude/commands/cmd-two.md names pstack",
    ]);
  });
});

describe("mode", () => {
  it("passes when the mode names every failure-born rule and every disabled item", () => {
    expect(failuresOf(makeFixture(), "mode")).toEqual([]);
  });

  it("names a rule that is not in the rule book, a rule the mode does not name and a disabled item the mode does not name", () => {
    const fixture = makeFixture({
      failureBornRules: ["2", "9"],
      modeText: "Rule 20 is named here\n",
    });

    expect(failuresOf(fixture, "mode")).toEqual([
      "disabled item is not named by the mode: beta",
      "failure-born rule 2 is not named by the mode as Rule 2",
      "failure-born rule 9 is not a rule of docs/CLAUDE.md",
      "failure-born rule 9 is not named by the mode as Rule 9",
    ]);
  });

  it("does not take Rule 20 for Rule 2", () => {
    const fixture = makeFixture({ modeText: "Never run beta. Rule 20 is named here\n" });

    expect(failuresOf(fixture, "mode")).toEqual([
      "failure-born rule 2 is not named by the mode as Rule 2",
    ]);
  });

  it("finds Rule 2 after an earlier Rule 20, and at the very end of the text", () => {
    const fixture = makeFixture({ modeText: "Never run beta. Rule 20 first, then Rule 2" });

    expect(failuresOf(fixture, "mode")).toEqual([]);
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

  it("allows the mentions the config lists, written with or without ~/", () => {
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
// What the parsers accept
// ---------------------------------------------------------------------------------------------

describe("the parsers", () => {
  it("reads a config with a note on an item and an item name that repeats under another kind", () => {
    const config = parseConfig(
      configTextOf({
        items: [
          { ...item("alpha", "skill", "use"), note: "a synthetic note" },
          item("alpha", "agent", "watch"),
        ],
      }),
    );

    expect(config).toEqual({
      items: [
        { name: "alpha", kind: "skill", verdict: "use", hard: false },
        { name: "alpha", kind: "agent", verdict: "watch", hard: false },
      ],
      failureBornRules: DEFAULT_RULES,
      allowedMentions: DEFAULT_MENTIONS,
    });
  });

  it("reads the pairings in file order and skips empty lines and lines that start with #", () => {
    const pairings = parsePairings("# a comment\n\nagent-one: skill-b\r\nagent-two: skill-a\n");

    expect(pairings).toEqual([
      { agent: "agent-one", skill: "skill-b" },
      { agent: "agent-two", skill: "skill-a" },
    ]);
  });

  it("reads the deny list of the settings file", () => {
    expect(parseSettingsDeny(settingsTextOf(["Read(./.env)", "Skill(pstack:beta)"]))).toEqual([
      "Read(./.env)",
      "Skill(pstack:beta)",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The refusals, one test each, each asserting its own fixed text
// ---------------------------------------------------------------------------------------------

describe("refusals of the installed copy and the inputs", () => {
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

  it("refuses when an input file is missing, naming the first missing one in the order of the inputs", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.productRoot, "docs/CLAUDE.md"));
    expect(refusalOf(() => readInputs(fixture.productRoot))).toBe(
      "input file missing: docs/CLAUDE.md",
    );

    rmSync(join(fixture.productRoot, "docs/.claude/pstack/pairings"));
    expect(refusalOf(() => readInputs(fixture.productRoot))).toBe(
      "input file missing: docs/.claude/pstack/pairings",
    );
  });

  it("refuses when the agents folder is missing", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.productRoot, "docs/.claude/agents"), { recursive: true });

    expect(refusalOf(() => readInputs(fixture.productRoot))).toBe(
      "input file missing: docs/.claude/agents",
    );
  });

  it("refuses a symbolic link inside the agents folder", () => {
    const fixture = makeFixture();
    const agentsFolder = join(fixture.productRoot, "docs/.claude/agents");
    symlinkSync(join(agentsFolder, "agent-one.md"), join(agentsFolder, "linked.md"));

    expect(refusalOf(() => readInputs(fixture.productRoot))).toBe(
      "entry that is neither a regular file nor a folder: docs/.claude/agents/linked.md",
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
    const reason = "unreadable path below a declared location: ";
    try {
      chmodSync(lockedFile, 0o000);
      expect(refusalOf(() => checkLeak(fixture.homeFolder, []))).toBe(`${reason}${lockedFile}`);
      chmodSync(lockedFile, 0o644);

      chmodSync(lockedFolder, 0o000);
      expect(refusalOf(() => checkLeak(fixture.homeFolder, []))).toBe(`${reason}${lockedFolder}`);
    } finally {
      chmodSync(lockedFile, 0o644);
      chmodSync(lockedFolder, 0o755);
    }
  });
});

describe("refusals of the config", () => {
  it("refuses a config that is not valid JSON", () => {
    expect(refusalOf(() => parseConfig("{not json"))).toBe("config.json is not valid JSON");
  });

  it("refuses a top level that is not an object", () => {
    for (const text of ["[]", "null", "3", '"items"']) {
      expect(refusalOf(() => parseConfig(text))).toBe("config.json top level is not an object");
    }
  });

  it("refuses a key that is not allowed, at the top level and in an item", () => {
    expect(refusalOf(() => parseConfig(configTextOf({ extra: 1 })))).toBe(
      "config.json has a key that is not allowed: extra",
    );
    expect(
      refusalOf(() =>
        parseConfig(configTextOf({ items: [{ ...item("alpha", "skill", "use"), colour: "red" }] })),
      ),
    ).toBe("config.json has a key that is not allowed: colour");
  });

  it("refuses a missing top-level key", () => {
    for (const key of ["items", "failureBornRules", "allowedMentions"]) {
      expect(refusalOf(() => parseConfig(configTextOf({ [key]: undefined })))).toBe(
        `config.json is missing the key: ${key}`,
      );
    }
  });

  it("refuses items that is not a list", () => {
    for (const items of [{}, "alpha", null]) {
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json items is not a list",
      );
    }
  });

  it("refuses an item without a usable name, and an element that is not an object", () => {
    const elements: unknown[] = [
      { kind: "skill", verdict: "use", hard: false },
      { name: "", kind: "skill", verdict: "use", hard: false },
      { name: 5, kind: "skill", verdict: "use", hard: false },
      null,
      "alpha",
      [],
      7,
    ];
    for (const element of elements) {
      expect(refusalOf(() => parseConfig(configTextOf({ items: [element] })))).toBe(
        "config.json item without a name",
      );
    }
  });

  it("refuses an item kind that is not skill or agent, and a missing kind", () => {
    for (const kind of ["plugin", "Skill", 3, undefined]) {
      const items = [{ name: "alpha", kind, verdict: "use", hard: false }];
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json item kind is not skill or agent: alpha",
      );
    }
  });

  it("refuses an item verdict that is not use, watch or disabled, and a missing verdict", () => {
    for (const verdict of ["allowed", "USE", true, undefined]) {
      const items = [{ name: "alpha", kind: "skill", verdict, hard: false }];
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json item verdict is not use, watch or disabled: alpha",
      );
    }
  });

  it("refuses an item hard that is not true or false, and a missing hard", () => {
    for (const hard of ["yes", 1, null, undefined]) {
      const items = [{ name: "alpha", kind: "skill", verdict: "use", hard }];
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json item hard is not true or false: alpha",
      );
    }
  });

  it("refuses an item note that is not a string", () => {
    for (const note of [5, null, ["a note"]]) {
      const items = [{ ...item("alpha", "skill", "use"), note }];
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json item note is not a string: alpha",
      );
    }
  });

  it("refuses an item that is hard and not disabled", () => {
    for (const verdict of ["use", "watch"] as const) {
      const items = [item("alpha", "skill", verdict, true)];
      expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
        "config.json item is hard and not disabled: alpha",
      );
    }
  });

  it("refuses a repeated item of the same kind and name", () => {
    const items = [
      item("alpha", "skill", "use"),
      item("beta", "skill", "use"),
      item("alpha", "skill", "watch"),
    ];

    expect(refusalOf(() => parseConfig(configTextOf({ items })))).toBe(
      "config.json repeated item: skill alpha",
    );
  });

  it("refuses failureBornRules that is not a list of digit strings", () => {
    for (const failureBornRules of ["26", [26], [""], ["2a"], ["-1"], ["2", null]]) {
      expect(refusalOf(() => parseConfig(configTextOf({ failureBornRules })))).toBe(
        "config.json failureBornRules is not a list of digit strings",
      );
    }
  });

  it("refuses allowedMentions that is not a list of strings", () => {
    for (const allowedMentions of ["~/.codex/shared.md", [1], ["~/.codex/shared.md", null]]) {
      expect(refusalOf(() => parseConfig(configTextOf({ allowedMentions })))).toBe(
        "config.json allowedMentions is not a list of strings",
      );
    }
  });
});

describe("the order of the refusals of the config", () => {
  const goodItem = item("alpha", "skill", "use");

  it.each([
    {
      name: "a top-level key that is not allowed before a missing key",
      text: JSON.stringify({ extra: 1 }),
      reason: "config.json has a key that is not allowed: extra",
    },
    {
      name: "a missing key before items that is not a list",
      text: JSON.stringify({ items: "alpha", failureBornRules: [] }),
      reason: "config.json is missing the key: allowedMentions",
    },
    {
      name: "items that is not a list before failureBornRules",
      text: configTextOf({ items: "alpha", failureBornRules: "26" }),
      reason: "config.json items is not a list",
    },
    {
      name: "an item key that is not allowed before its missing name",
      text: configTextOf({ items: [{ colour: "red" }] }),
      reason: "config.json has a key that is not allowed: colour",
    },
    {
      name: "the kind before the verdict",
      text: configTextOf({ items: [{ name: "alpha", kind: "x", verdict: "x", hard: "x" }] }),
      reason: "config.json item kind is not skill or agent: alpha",
    },
    {
      name: "the verdict before hard",
      text: configTextOf({ items: [{ name: "alpha", kind: "skill", verdict: "x", hard: "x" }] }),
      reason: "config.json item verdict is not use, watch or disabled: alpha",
    },
    {
      name: "the note before hard together with a verdict other than disabled",
      text: configTextOf({ items: [{ ...item("alpha", "skill", "use", true), note: 5 }] }),
      reason: "config.json item note is not a string: alpha",
    },
    {
      name: "a later item's defect before a repeated item",
      text: configTextOf({
        items: [goodItem, goodItem, { ...item("beta", "skill", "use"), note: 5 }],
      }),
      reason: "config.json item note is not a string: beta",
    },
    {
      name: "a repeated item before failureBornRules",
      text: configTextOf({ items: [goodItem, goodItem], failureBornRules: "26" }),
      reason: "config.json repeated item: skill alpha",
    },
    {
      name: "failureBornRules before allowedMentions",
      text: configTextOf({ failureBornRules: "26", allowedMentions: "x" }),
      reason: "config.json failureBornRules is not a list of digit strings",
    },
  ])("gives $name", ({ text, reason }) => {
    expect(refusalOf(() => parseConfig(text))).toBe(reason);
  });

  it("parses the config, then the pairings, then the settings deny list", () => {
    const refusalForFixture = (overrides: FixtureOverrides): string =>
      refusalOf(() => runFixture(makeFixture(overrides)));

    expect(
      refusalForFixture({ configText: "{not json", pairingsText: "bad line", settingsText: "{" }),
    ).toBe("config.json is not valid JSON");
    expect(refusalForFixture({ pairingsText: "bad line", settingsText: "{" })).toBe(
      "pairings line not in the form agent: skill: 1",
    );
    expect(refusalForFixture({ settingsText: "{" })).toBe("settings.json is not valid JSON");
  });
});

describe("refusals of the pairings and the settings", () => {
  it("refuses a pairings line not in the form agent: skill, naming its line number", () => {
    const badLines = [
      "agent-one alpha",
      "Agent-One: alpha",
      "agent-one:alpha",
      "agent-one:  alpha",
      "agent-one: alpha extra",
      " agent-one: alpha",
      "   ",
    ];
    for (const badLine of badLines) {
      const text = ["# a comment", "", "agent-one: beta", badLine].join("\n");
      expect(refusalOf(() => parsePairings(text))).toBe(
        "pairings line not in the form agent: skill: 4",
      );
    }
  });

  it("refuses a pairing that repeats, and gives the form defect of a line before a later repeat", () => {
    expect(
      refusalOf(() => parsePairings("agent-one: alpha\nagent-two: alpha\nagent-one: alpha\n")),
    ).toBe("repeated pairing: agent-one: alpha");
    expect(refusalOf(() => parsePairings("agent-one: alpha\nbad line\nagent-one: alpha\n"))).toBe(
      "pairings line not in the form agent: skill: 2",
    );
  });

  it("refuses a settings file that is not valid JSON", () => {
    expect(refusalOf(() => parseSettingsDeny("{not json"))).toBe("settings.json is not valid JSON");
  });

  it("refuses a settings file with no permissions.deny list of strings", () => {
    const texts = [
      "{}",
      "[]",
      '{"permissions": []}',
      '{"permissions": {}}',
      '{"permissions": {"deny": "Read(./.env)"}}',
      '{"permissions": {"deny": ["Read(./.env)", 4]}}',
    ];
    for (const text of texts) {
      expect(refusalOf(() => parseSettingsDeny(text))).toBe(
        "settings.json has no permissions.deny list of strings",
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------------------------

describe("output", () => {
  const passing = (name: CheckName): CheckResult => ({ name, failures: [] });

  it("prints a PASS or FAIL line per check, each failure indented under its check, then the verdict", () => {
    const manyFailures = Array.from(
      { length: 30 },
      (_, index) => `screened item is not installed: skill item-${index}`,
    );
    const results: CheckResult[] = [
      {
        name: "unscreened",
        failures: ["pstack agent not screened: eta", "pstack skill not screened: zeta"],
      },
      passing("flag"),
      passing("deny"),
      { name: "pairings", failures: manyFailures },
      passing("boundary"),
      passing("mode"),
      passing("leak"),
    ];

    expect(formatReport(results)).toEqual([
      "FAIL unscreened",
      "  - pstack agent not screened: eta",
      "  - pstack skill not screened: zeta",
      "PASS flag",
      "PASS deny",
      "FAIL pairings",
      ...manyFailures.map((failure) => `  - ${failure}`),
      "PASS boundary",
      "PASS mode",
      "PASS leak",
      "verify:pstack FAILED (2 checks failed)",
    ]);
  });

  it("ends a clean report with the PASSED line", () => {
    const names: CheckName[] = [
      "unscreened",
      "flag",
      "deny",
      "pairings",
      "boundary",
      "mode",
      "leak",
    ];

    expect(formatReport(names.map(passing))).toEqual([
      "PASS unscreened",
      "PASS flag",
      "PASS deny",
      "PASS pairings",
      "PASS boundary",
      "PASS mode",
      "PASS leak",
      "verify:pstack PASSED",
    ]);
  });

  it("formats a refusal as one REFUSED line", () => {
    expect(formatRefusal("config.json is not valid JSON")).toBe(
      "verify:pstack REFUSED: config.json is not valid JSON",
    );
  });

  it("exits 0 for no failed check and 1 for any", () => {
    expect(exitCodeOf(0)).toBe(0);
    expect(exitCodeOf(1)).toBe(1);
    expect(exitCodeOf(7)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The real config, pairings, settings, mode, rule book and folders, read through process.cwd() as
// the runner reads them. None of these asserts anything about the installed plugin or the home
// folder.
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

const REAL_CONFIG_PATH = "docs/.claude/pstack/config.json";
const REAL_PAIRINGS_PATH = "docs/.claude/pstack/pairings";
const REAL_SETTINGS_PATH = "docs/.claude/settings.json";
const REAL_CLAUDE_PATH = "docs/CLAUDE.md";
const REAL_MODE_PATH = "docs/.claude/skills/lombakita-mode/SKILL.md";

describe("the real files", () => {
  it("parses the config without a refusal and finds items", () => {
    const config = parseConfig(readDocFile(REAL_CONFIG_PATH));

    expect(config.items.length).toBeGreaterThan(0);
  });

  it("parses the pairings without a refusal", () => {
    expect(() => parsePairings(readDocFile(REAL_PAIRINGS_PATH))).not.toThrow();
  });

  it("parses the settings deny list without a refusal and finds entries", () => {
    const denyEntries = parseSettingsDeny(readDocFile(REAL_SETTINGS_PATH));

    expect(denyEntries.length).toBeGreaterThan(0);
  });

  it("has the mode name every failure-born rule and every disabled item, and the rule book hold those rules", () => {
    const config = parseConfig(readDocFile(REAL_CONFIG_PATH));
    const ruleNumbers = readRuleNumbers(readDocFile(REAL_CLAUDE_PATH));

    expect(checkMode(config, ruleNumbers, readDocFile(REAL_MODE_PATH))).toEqual([]);
  });

  it("finds no file in the real agents and commands folders that names the word", () => {
    const rawInputs = readInputs(process.cwd());

    expect(checkBoundary(rawInputs.agentFiles, rawInputs.commandFiles)).toEqual([]);
  });

  it("gives every hard item of the real config its deny entry and every pstack deny entry a hard item", () => {
    const config = parseConfig(readDocFile(REAL_CONFIG_PATH));
    const denyEntries = parseSettingsDeny(readDocFile(REAL_SETTINGS_PATH));

    expect(checkDeny(config.items, denyEntries)).toEqual([]);
  });
});
