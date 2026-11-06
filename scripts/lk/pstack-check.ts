/**
 * The pstack check: whether the installed pstack plugin, the config and the pairings of the pstack
 * folder, the deny list of the settings file, the mode, and the agent and command files of
 * Lombakita still agree. Seven read-only checks run in a fixed order: unscreened, flag, deny,
 * pairings, boundary, mode and leak. It writes nothing, never runs the claude command and never
 * touches the network.
 *
 * WHY IT REFUSES AND DOES NOT SKIP. A config or settings file it cannot parse, a pairings line it
 * cannot read, an input file that is missing and a path it cannot open all stop the run. A check
 * that skips what it cannot read reports a population smaller than the one it claims, and an empty
 * failure list is the value that reads as a pass. Every refusal is one reason, printed by
 * formatRefusal.
 *
 * Every function takes its inputs as parameters, the home folder and the product root included. None
 * of them reads the real home folder or the real docs folder on its own; the runner supplies both.
 *
 * Run:  node --import tsx scripts/lk/verify-pstack.ts
 */

import { lstatSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { join, relative } from "node:path";

const PLUGIN_KEY = "pstack@cursor-plugins";
const INSTALLED_PLUGINS_IN_HOME = ".claude/plugins/installed_plugins.json";

const CONFIG_PATH = "docs/.claude/pstack/config.json";
const PAIRINGS_PATH = "docs/.claude/pstack/pairings";
const SETTINGS_PATH = "docs/.claude/settings.json";
const MODE_PATH = "docs/.claude/skills/lombakita-mode/SKILL.md";
const CLAUDE_PATH = "docs/CLAUDE.md";
const FOLDER_PATHS = {
  agents: "docs/.claude/agents",
  commands: "docs/.claude/commands",
} as const;

const RULES_START_HEADING = "## Implementation Rules";
const RULES_END_HEADING = "## UI Level Defaults";
const MODEL_INVOCATION_OFF_LINE = "disable-model-invocation: true";

const CONFIG_KEYS = ["items", "failureBornRules", "allowedMentions"] as const;
const ITEM_KEYS = ["name", "kind", "verdict", "hard", "note"] as const;
const ITEM_KINDS = ["skill", "agent"] as const;
const ITEM_VERDICTS = ["use", "watch", "disabled"] as const;
const ITEM_WITHOUT_NAME = "config.json item without a name";
const DIGITS_ONLY = /^[0-9]+$/;
const PAIRING_LINE = /^([a-z0-9-]+): ([a-z0-9-]+)$/;
const PSTACK_DENY_ENTRY = /^(Agent|Skill)\(pstack:[^)]*\)$/;

const LEAK_LOCATIONS = [
  ".claude/CLAUDE.md",
  ".claude/claude-only.md",
  ".codex/shared.md",
  ".claude/rules",
  ".claude/skills",
  ".claude/commands",
  ".claude/agents",
  ".claude/settings.json",
  ".claude/plugins",
] as const;

export const CHECK_NAMES = [
  "unscreened",
  "flag",
  "deny",
  "pairings",
  "boundary",
  "mode",
  "leak",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export class PstackRefusal extends Error {}

function refuse(reason: string): never {
  throw new PstackRefusal(reason);
}

const isAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isListOfStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((element) => typeof element === "string");

const isOneOf = <Value extends string>(allowed: readonly Value[], value: unknown): value is Value =>
  allowed.some((candidate) => candidate === value);

const sortedByText = (lines: readonly string[]): string[] => [...lines].sort();

const splitLines = (text: string): string[] => text.split(/\r?\n/);

// ---------------------------------------------------------------------------------------------
// The installed copy
// ---------------------------------------------------------------------------------------------

function installPathFromPluginsFile(file: string): string {
  const reason = `installed_plugins.json is missing or has no ${PLUGIN_KEY} entry`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return refuse(reason);
  }
  const plugins = isRecord(parsed) ? parsed.plugins : undefined;
  const entries = isRecord(plugins) ? plugins[PLUGIN_KEY] : undefined;
  const first: unknown = Array.isArray(entries) ? entries[0] : undefined;
  const installPath = isRecord(first) ? first.installPath : undefined;
  if (typeof installPath !== "string") return refuse(reason);
  return installPath;
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const readInstalledPath = (homeFolder: string): string => {
  const installPath = installPathFromPluginsFile(join(homeFolder, INSTALLED_PLUGINS_IN_HOME));
  if (!isFolder(installPath)) refuse(`installPath is not a folder: ${installPath}`);
  return installPath;
};

function readFolderOrRefuse(folder: string): Dirent[] {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return refuse(`unreadable path below a declared location: ${folder}`);
  }
}

function readFileOrRefuse(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    return refuse(`unreadable path below a declared location: ${file}`);
  }
}

export interface InstalledSkill {
  name: string;
  modelInvocable: boolean;
}

export interface InstalledItems {
  skills: InstalledSkill[];
  agents: string[];
}

const frontmatterLinesOf = (skillText: string): string[] => {
  const lines = splitLines(skillText);
  if (lines[0] !== "---") return [];
  const closingAt = lines.indexOf("---", 1);
  return closingAt === -1 ? [] : lines.slice(1, closingAt);
};

const readSkillText = (skillFile: string): string => {
  try {
    return readFileSync(skillFile, "utf8");
  } catch (error) {
    if (isAbsent(error)) return "";
    return refuse(`unreadable path below a declared location: ${skillFile}`);
  }
};

const entriesOfInstalledFolder = (installedPath: string, name: string): Dirent[] => {
  const folder = join(installedPath, name);
  if (statSync(folder, { throwIfNoEntry: false }) === undefined) return [];
  return readFolderOrRefuse(folder);
};

const readInstalledSkills = (installedPath: string): InstalledSkill[] =>
  entriesOfInstalledFolder(installedPath, "skills")
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillText = readSkillText(join(installedPath, "skills", entry.name, "SKILL.md"));
      const switchedOff = frontmatterLinesOf(skillText).some(
        (line) => line.trimEnd() === MODEL_INVOCATION_OFF_LINE,
      );
      return { name: entry.name, modelInvocable: !switchedOff };
    });

const readInstalledAgents = (installedPath: string): string[] =>
  entriesOfInstalledFolder(installedPath, "agents")
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -".md".length));

/** A skill counts as installed when its folder exists, an agent when its `.md` file exists. */
export const readInstalledItems = (installedPath: string): InstalledItems => ({
  skills: readInstalledSkills(installedPath),
  agents: readInstalledAgents(installedPath),
});

const isInstalled = (installed: InstalledItems, kind: ItemKind, name: string): boolean =>
  kind === "skill"
    ? installed.skills.some((skill) => skill.name === name)
    : installed.agents.includes(name);

// ---------------------------------------------------------------------------------------------
// The config, the pairings and the settings deny list
// ---------------------------------------------------------------------------------------------

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemVerdict = (typeof ITEM_VERDICTS)[number];

/** The `note` of a config item is validated by parseConfig and not kept, because no check reads it. */
export interface ConfigItem {
  name: string;
  kind: ItemKind;
  verdict: ItemVerdict;
  hard: boolean;
}

export interface PstackConfig {
  items: ConfigItem[];
  failureBornRules: string[];
  allowedMentions: string[];
}

export interface Pairing {
  agent: string;
  skill: string;
}

function parseJsonOrRefuse(text: string, reason: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return refuse(reason);
  }
}

function refuseKeysOutside(record: Record<string, unknown>, allowedKeys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) refuse(`config.json has a key that is not allowed: ${key}`);
  }
}

function refuseMissingConfigKeys(record: Record<string, unknown>): void {
  const keys = Object.keys(record);
  for (const key of CONFIG_KEYS) {
    if (!keys.includes(key)) refuse(`config.json is missing the key: ${key}`);
  }
}

function parseConfigItem(element: unknown): ConfigItem {
  if (!isRecord(element)) return refuse(ITEM_WITHOUT_NAME);
  refuseKeysOutside(element, ITEM_KEYS);
  const { name, kind, verdict, hard, note } = element;
  if (typeof name !== "string" || name === "") return refuse(ITEM_WITHOUT_NAME);
  if (!isOneOf(ITEM_KINDS, kind)) {
    return refuse(`config.json item kind is not skill or agent: ${name}`);
  }
  if (!isOneOf(ITEM_VERDICTS, verdict)) {
    return refuse(`config.json item verdict is not use, watch or disabled: ${name}`);
  }
  if (typeof hard !== "boolean") {
    return refuse(`config.json item hard is not true or false: ${name}`);
  }
  if (note !== undefined && typeof note !== "string") {
    return refuse(`config.json item note is not a string: ${name}`);
  }
  if (hard && verdict !== "disabled") {
    return refuse(`config.json item is hard and not disabled: ${name}`);
  }
  return { name, kind, verdict, hard };
}

function refuseRepeatedItem(items: readonly ConfigItem[]): void {
  const seen = new Set<string>();
  for (const { kind, name } of items) {
    const key = `${kind} ${name}`;
    if (seen.has(key)) refuse(`config.json repeated item: ${key}`);
    seen.add(key);
  }
}

/** Refuses with the first defect, in the order the reasons are listed in this function. */
export const parseConfig = (configText: string): PstackConfig => {
  const parsed = parseJsonOrRefuse(configText, "config.json is not valid JSON");
  if (!isRecord(parsed)) return refuse("config.json top level is not an object");
  refuseKeysOutside(parsed, CONFIG_KEYS);
  refuseMissingConfigKeys(parsed);
  const { items: rawItems, failureBornRules, allowedMentions } = parsed;
  if (!Array.isArray(rawItems)) return refuse("config.json items is not a list");
  const items = rawItems.map(parseConfigItem);
  refuseRepeatedItem(items);
  if (
    !isListOfStrings(failureBornRules) ||
    !failureBornRules.every((rule) => DIGITS_ONLY.test(rule))
  ) {
    return refuse("config.json failureBornRules is not a list of digit strings");
  }
  if (!isListOfStrings(allowedMentions)) {
    return refuse("config.json allowedMentions is not a list of strings");
  }
  return { items, failureBornRules, allowedMentions };
};

/** A line that is empty or starts with # is skipped. Line numbers count every line of the file. */
export const parsePairings = (pairingsText: string): Pairing[] => {
  const pairings: Pairing[] = [];
  splitLines(pairingsText).forEach((line, index) => {
    if (line === "" || line.startsWith("#")) return;
    const match = PAIRING_LINE.exec(line);
    const agent = match?.[1];
    const skill = match?.[2];
    if (agent === undefined || skill === undefined) {
      refuse(`pairings line not in the form agent: skill: ${index + 1}`);
    }
    if (pairings.some((pairing) => pairing.agent === agent && pairing.skill === skill)) {
      refuse(`repeated pairing: ${agent}: ${skill}`);
    }
    pairings.push({ agent, skill });
  });
  return pairings;
};

export const parseSettingsDeny = (settingsText: string): string[] => {
  const parsed = parseJsonOrRefuse(settingsText, "settings.json is not valid JSON");
  const permissions = isRecord(parsed) ? parsed.permissions : undefined;
  const deny = isRecord(permissions) ? permissions.deny : undefined;
  if (!isListOfStrings(deny))
    return refuse("settings.json has no permissions.deny list of strings");
  return deny;
};

// ---------------------------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------------------------

export interface FolderFile {
  name: string;
  text: string;
}

export interface RawInputs {
  configText: string;
  pairingsText: string;
  settingsText: string;
  modeText: string;
  claudeText: string;
  agentFiles: FolderFile[];
  commandFiles: FolderFile[];
}

function readInputFile(productRoot: string, relativePath: string): string {
  try {
    return readFileSync(join(productRoot, relativePath), "utf8");
  } catch (error) {
    if (isAbsent(error)) return refuse(`input file missing: ${relativePath}`);
    throw error;
  }
}

/**
 * Every regular file at any depth below a folder, whatever its name. The boundary is that the word
 * never appears in any file of the two folders, so no file may go unread, and an entry that is
 * neither a regular file nor a folder is refused because it cannot be classified. The name of a file
 * is its path below the folder, with `/` between the parts.
 */
function readFolderFiles(productRoot: string, relativeFolder: string): FolderFile[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(productRoot, relativeFolder), { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return refuse(`input file missing: ${relativeFolder}`);
    throw error;
  }
  return readFilesBelow(productRoot, relativeFolder, entries);
}

/** Names are relative to `relativeDir`, which is itself relative to the product root. */
function readFilesBelow(
  productRoot: string,
  relativeDir: string,
  entries: readonly Dirent[],
): FolderFile[] {
  return entries.flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      const nestedEntries = readdirSync(join(productRoot, relativePath), { withFileTypes: true });
      const nestedFiles = readFilesBelow(productRoot, relativePath, nestedEntries);
      return nestedFiles.map((file) => ({ name: `${entry.name}/${file.name}`, text: file.text }));
    }
    if (!entry.isFile()) {
      return refuse(`entry that is neither a regular file nor a folder: ${relativePath}`);
    }
    return [{ name: entry.name, text: readFileSync(join(productRoot, relativePath), "utf8") }];
  });
}

export const readInputs = (productRoot: string): RawInputs => ({
  configText: readInputFile(productRoot, CONFIG_PATH),
  pairingsText: readInputFile(productRoot, PAIRINGS_PATH),
  settingsText: readInputFile(productRoot, SETTINGS_PATH),
  modeText: readInputFile(productRoot, MODE_PATH),
  claudeText: readInputFile(productRoot, CLAUDE_PATH),
  agentFiles: readFolderFiles(productRoot, FOLDER_PATHS.agents),
  commandFiles: readFolderFiles(productRoot, FOLDER_PATHS.commands),
});

/** The top-level numbered lines of the rule list, as digit strings in file order. */
export const readRuleNumbers = (claudeText: string): string[] => {
  const lines = splitLines(claudeText);
  const startAt = lines.indexOf(RULES_START_HEADING);
  if (startAt === -1) return [];
  const afterStart = lines.slice(startAt + 1);
  const endAt = afterStart.indexOf(RULES_END_HEADING);
  const section = endAt === -1 ? afterStart : afterStart.slice(0, endAt);
  return section.flatMap((line) => {
    const number = /^(\d+)\. /.exec(line)?.[1];
    return number === undefined ? [] : [number];
  });
};

export interface CheckInputs {
  config: PstackConfig;
  pairings: Pairing[];
  denyEntries: string[];
  installed: InstalledItems;
  modeText: string;
  ruleNumbers: string[];
  agentFiles: FolderFile[];
  commandFiles: FolderFile[];
  homeFolder: string;
}

/**
 * Parses the files the checks read, in the order a refusal is listed. It also reads the installed
 * plugin folder from disk, so it is not a function of `raw` alone.
 */
export const buildCheckInputs = (
  raw: RawInputs,
  installedPath: string,
  homeFolder: string,
): CheckInputs => ({
  config: parseConfig(raw.configText),
  pairings: parsePairings(raw.pairingsText),
  denyEntries: parseSettingsDeny(raw.settingsText),
  installed: readInstalledItems(installedPath),
  modeText: raw.modeText,
  ruleNumbers: readRuleNumbers(raw.claudeText),
  agentFiles: raw.agentFiles,
  commandFiles: raw.commandFiles,
  homeFolder,
});

// ---------------------------------------------------------------------------------------------
// The seven checks. Each returns its failure lines; an empty array is a pass.
// ---------------------------------------------------------------------------------------------

const findItem = (
  items: readonly ConfigItem[],
  kind: ItemKind,
  name: string,
): ConfigItem | undefined => items.find((item) => item.kind === kind && item.name === name);

export const checkUnscreened = (
  items: readonly ConfigItem[],
  installed: InstalledItems,
): string[] => {
  const unscreenedSkills = installed.skills
    .filter((skill) => findItem(items, "skill", skill.name) === undefined)
    .map((skill) => `pstack skill not screened: ${skill.name}`);
  const unscreenedAgents = installed.agents
    .filter((name) => findItem(items, "agent", name) === undefined)
    .map((name) => `pstack agent not screened: ${name}`);
  const itemsNotInstalled = items
    .filter((item) => !isInstalled(installed, item.kind, item.name))
    .map((item) => `screened item is not installed: ${item.kind} ${item.name}`);
  return sortedByText([...unscreenedSkills, ...unscreenedAgents, ...itemsNotInstalled]);
};

export const checkFlag = (items: readonly ConfigItem[], installed: InstalledItems): string[] => {
  const failures = installed.skills
    .filter((skill) => skill.modelInvocable)
    .filter((skill) => findItem(items, "skill", skill.name)?.verdict !== "disabled")
    .map((skill) => `skill is model-invocable and not disabled: ${skill.name}`);
  return sortedByText(failures);
};

const denyEntryOf = (item: ConfigItem): string =>
  `${item.kind === "agent" ? "Agent" : "Skill"}(pstack:${item.name})`;

export const checkDeny = (
  items: readonly ConfigItem[],
  denyEntries: readonly string[],
): string[] => {
  const hardItems = items.filter((item) => item.hard);
  const expectedEntries = hardItems.map(denyEntryOf);
  const hardItemsWithoutEntry = hardItems
    .filter((item) => !denyEntries.includes(denyEntryOf(item)))
    .map((item) => `hard item without a deny entry: ${item.kind} ${item.name}`);
  const entriesWithoutHardItem = denyEntries
    .filter((entry) => PSTACK_DENY_ENTRY.test(entry))
    .filter((entry) => !expectedEntries.includes(entry))
    .map((entry) => `deny entry without a hard item: ${entry}`);
  return sortedByText([...hardItemsWithoutEntry, ...entriesWithoutHardItem]);
};

const firstPairingFailure = (
  pairing: Pairing,
  items: readonly ConfigItem[],
  installed: InstalledItems,
  agentFiles: readonly FolderFile[],
): string | undefined => {
  if (!agentFiles.some((file) => file.name === `${pairing.agent}.md`)) {
    return `paired agent does not exist: ${pairing.agent}`;
  }
  if (!isInstalled(installed, "skill", pairing.skill)) {
    return `paired skill is not installed: ${pairing.skill}`;
  }
  const item = findItem(items, "skill", pairing.skill);
  if (item === undefined) return `paired skill is not screened: ${pairing.skill}`;
  if (item.verdict === "disabled") return `paired skill is disabled: ${pairing.skill}`;
  return undefined;
};

/** One line per failing pairing, in the order of the pairings file. */
export const checkPairings = (
  pairings: readonly Pairing[],
  items: readonly ConfigItem[],
  installed: InstalledItems,
  agentFiles: readonly FolderFile[],
): string[] =>
  pairings.flatMap((pairing) => {
    const failure = firstPairingFailure(pairing, items, installed, agentFiles);
    return failure === undefined ? [] : [failure];
  });

const namesPstack = (file: FolderFile): boolean => file.text.toLowerCase().includes("pstack");

export const checkBoundary = (
  agentFiles: readonly FolderFile[],
  commandFiles: readonly FolderFile[],
): string[] => {
  const namingAgents = agentFiles.filter(namesPstack);
  const namingCommands = commandFiles.filter(namesPstack);
  const failures = [
    ...namingAgents.map((file) => `${FOLDER_PATHS.agents}/${file.name} names pstack`),
    ...namingCommands.map((file) => `${FOLDER_PATHS.commands}/${file.name} names pstack`),
  ];
  return sortedByText(failures);
};

/** `Rule <n>` counts only when the next character is not a digit, so Rule 4 is not found in Rule 41. */
const modeNamesRule = (modeText: string, rule: string): boolean => {
  const needle = `Rule ${rule}`;
  let at = modeText.indexOf(needle);
  while (at !== -1) {
    const following = modeText.charAt(at + needle.length);
    if (!/[0-9]/.test(following)) return true;
    at = modeText.indexOf(needle, at + 1);
  }
  return false;
};

export const checkMode = (
  config: PstackConfig,
  ruleNumbers: readonly string[],
  modeText: string,
): string[] => {
  const rulesNotInRuleBook = config.failureBornRules
    .filter((rule) => !ruleNumbers.includes(rule))
    .map((rule) => `failure-born rule ${rule} is not a rule of docs/CLAUDE.md`);
  const rulesNotNamed = config.failureBornRules
    .filter((rule) => !modeNamesRule(modeText, rule))
    .map((rule) => `failure-born rule ${rule} is not named by the mode as Rule ${rule}`);
  const disabledItemsNotNamed = config.items
    .filter((item) => item.verdict === "disabled")
    .filter((item) => !modeText.includes(item.name))
    .map((item) => `disabled item is not named by the mode: ${item.name}`);
  return sortedByText([...rulesNotInRuleBook, ...rulesNotNamed, ...disabledItemsNotNamed]);
};

const shownPath = (homeFolder: string, path: string): string => `~/${relative(homeFolder, path)}`;

const absoluteMention = (homeFolder: string, mention: string): string =>
  mention.startsWith("~/") ? join(homeFolder, mention.slice(2)) : mention;

const leakLinesOfFile = (
  homeFolder: string,
  allowed: ReadonlySet<string>,
  path: string,
  text: string,
): string[] => {
  const mentionsLombakita = text.toLowerCase().includes("lombakita");
  if (!mentionsLombakita || allowed.has(path)) return [];
  return [`${shownPath(homeFolder, path)} names Lombakita and is not an allowed mention`];
};

/** Files below `folder`. Links are not followed, so a link is skipped and never read. */
const filesBelow = (folder: string, entries: readonly Dirent[]): string[] =>
  entries.flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return filesBelow(path, readFolderOrRefuse(path));
    if (entry.isFile()) return [path];
    return refuse(`entry that is neither a regular file nor a folder: ${path}`);
  });

const leakLinesOfLocation = (
  homeFolder: string,
  allowed: ReadonlySet<string>,
  path: string,
): string[] => {
  const unreadable = [`location unreadable: ${shownPath(homeFolder, path)}`];
  let stats: Stats | undefined;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return unreadable;
  }
  if (stats === undefined || stats.isSymbolicLink()) return [];
  if (stats.isFile()) {
    try {
      return leakLinesOfFile(homeFolder, allowed, path, readFileSync(path, "utf8"));
    } catch {
      return unreadable;
    }
  }
  if (!stats.isDirectory()) {
    return refuse(`entry that is neither a regular file nor a folder: ${path}`);
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return unreadable;
  }
  return filesBelow(path, entries).flatMap((file) =>
    leakLinesOfFile(homeFolder, allowed, file, readFileOrRefuse(file).toString("utf8")),
  );
};

export const checkLeak = (homeFolder: string, allowedMentions: readonly string[]): string[] => {
  const allowed = new Set(allowedMentions.map((mention) => absoluteMention(homeFolder, mention)));
  const failures = LEAK_LOCATIONS.flatMap((location) =>
    leakLinesOfLocation(homeFolder, allowed, join(homeFolder, location)),
  );
  return sortedByText(failures);
};

// ---------------------------------------------------------------------------------------------
// Running and reporting
// ---------------------------------------------------------------------------------------------

export interface CheckResult {
  name: CheckName;
  failures: string[];
}

export const runChecks = (inputs: CheckInputs): CheckResult[] => [
  { name: "unscreened", failures: checkUnscreened(inputs.config.items, inputs.installed) },
  { name: "flag", failures: checkFlag(inputs.config.items, inputs.installed) },
  { name: "deny", failures: checkDeny(inputs.config.items, inputs.denyEntries) },
  {
    name: "pairings",
    failures: checkPairings(
      inputs.pairings,
      inputs.config.items,
      inputs.installed,
      inputs.agentFiles,
    ),
  },
  { name: "boundary", failures: checkBoundary(inputs.agentFiles, inputs.commandFiles) },
  { name: "mode", failures: checkMode(inputs.config, inputs.ruleNumbers, inputs.modeText) },
  { name: "leak", failures: checkLeak(inputs.homeFolder, inputs.config.allowedMentions) },
];

export const countFailedChecks = (results: readonly CheckResult[]): number =>
  results.filter((result) => result.failures.length > 0).length;

export const formatReport = (results: readonly CheckResult[]): string[] => {
  const checkLines = results.flatMap((result) =>
    result.failures.length === 0
      ? [`PASS ${result.name}`]
      : [`FAIL ${result.name}`, ...result.failures.map((failure) => `  - ${failure}`)],
  );
  const failedChecks = countFailedChecks(results);
  const lastLine =
    failedChecks === 0
      ? "verify:pstack PASSED"
      : `verify:pstack FAILED (${failedChecks} checks failed)`;
  return [...checkLines, lastLine];
};

export const formatRefusal = (reason: string): string => `verify:pstack REFUSED: ${reason}`;

export const exitCodeOf = (failedChecks: number): 0 | 1 => (failedChecks === 0 ? 0 : 1);
