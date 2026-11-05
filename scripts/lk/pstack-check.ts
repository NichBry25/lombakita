/**
 * The pstack check: whether the installed pstack plugin, the register, the mode and the lock still
 * agree. Six read-only checks run in a fixed order: drift, unclassified, pointer, flag, failure-born
 * and leak. It writes nothing, never runs the claude command and never touches the network.
 *
 * WHY IT REFUSES AND DOES NOT SKIP. A table the parser cannot classify, a lock line it cannot read,
 * an installed entry it cannot hash and a path it cannot open all stop the run. A check that skips
 * what it cannot read reports a population smaller than the one it claims, and an empty failure list
 * is the value that reads as a pass. Every refusal is one reason, printed by formatRefusal.
 *
 * Every function takes its inputs as parameters, the home folder and the product root included. None
 * of them reads the real home folder or the real docs folder on its own; the runner supplies both.
 *
 * Run:  node --import tsx scripts/lk/verify-pstack.ts
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { join, relative } from "node:path";

const PLUGIN_KEY = "pstack@cursor-plugins";
const INSTALLED_PLUGINS_IN_HOME = ".claude/plugins/installed_plugins.json";

const REGISTER_PATH = "docs/project/pstack-policy.md";
const MODE_PATH = "docs/.claude/skills/lombakita-mode/SKILL.md";
const LOCK_PATH = "docs/project/pstack-lock.sha256";
const CLAUDE_PATH = "docs/CLAUDE.md";
const FOLDER_PATHS = {
  commands: "docs/.claude/commands",
  agents: "docs/.claude/agents",
  skills: "docs/.claude/skills",
  hooks: "docs/.claude/hooks",
} as const;

const RULES_START_HEADING = "## Implementation Rules";
const RULES_END_HEADING = "## UI Level Defaults";
const ALLOWED_MENTIONS_HEADING = "## Allowed mentions of Lombakita at user level";
const VENDORED_LIST_FILE = "VENDORED-UI-SKILLS.md";
const IN_USE_FOLDER = ".in_use";
const MODEL_INVOCATION_OFF_LINE = "disable-model-invocation: true";

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

const STATUSES = ["ADOPT", "REFERENCE-ONLY", "PARKED", "NOT-USED", "FORBIDDEN"];
const BUCKETS = ["G1", "G2", "L"];
const AUTHORITIES = ["pstack", "pstack+Lombakita", "Lombakita", "n/a"];
const PSTACK_KINDS = ["skill", "agent"];

export const CHECK_NAMES = [
  "drift",
  "unclassified",
  "pointer",
  "flag",
  "failure-born",
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

const sortedByText = (lines: readonly string[]): string[] => [...lines].sort();

const splitLines = (text: string): string[] => text.split(/\r?\n/);

const sha256Of = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

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

const hashFolderInto = (
  hashes: Map<string, string>,
  rootFolder: string,
  relativeFolder: string,
): void => {
  for (const entry of readFolderOrRefuse(join(rootFolder, relativeFolder))) {
    const relativePath = `${relativeFolder}/${entry.name}`;
    const absolutePath = join(rootFolder, relativePath);
    if (entry.isDirectory()) {
      const isInUseFolder = relativeFolder === "." && entry.name === IN_USE_FOLDER;
      if (!isInUseFolder) hashFolderInto(hashes, rootFolder, relativePath);
    } else if (entry.isFile()) {
      hashes.set(relativePath, sha256Of(readFileOrRefuse(absolutePath)));
    } else {
      refuse(`entry that is neither a regular file nor a folder: ${absolutePath}`);
    }
  }
};

/**
 * The sha256 of every regular file below `rootFolder`, keyed by its `./`-relative path.
 *
 * The folder `.in_use` at the root is skipped whole, because a running Claude session writes a pid
 * file there. A link, or any entry that is not a regular file or a folder, is refused: the lock
 * covers regular files only, so a link would be an entry the lock cannot vouch for.
 */
export const hashTree = (rootFolder: string): Map<string, string> => {
  const hashes = new Map<string, string>();
  hashFolderInto(hashes, rootFolder, ".");
  return hashes;
};

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

// ---------------------------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------------------------

export interface PstackItemRow {
  name: string;
  kind: string;
  status: string;
}

export interface RuleRow {
  rule: string;
  origin: string;
}

export interface LombakitaItemRow {
  item: string;
}

export interface Register {
  pstackItems: PstackItemRow[];
  rules: RuleRow[];
  lombakitaItems: LombakitaItemRow[];
  allowedMentions: string[];
}

interface TableSpec {
  heading: string;
  header: string;
  allowed: readonly { column: number; values: readonly string[] }[];
}

const TABLE_A: TableSpec = {
  heading: "## Table A: pstack skills and agents",
  header: "| pstack item | Kind | Status | Authority | Lombakita counterpart | Note |",
  allowed: [
    { column: 1, values: PSTACK_KINDS },
    { column: 2, values: STATUSES },
    { column: 3, values: AUTHORITIES },
  ],
};

const TABLE_B: TableSpec = {
  heading: "## Table B: Lombakita rules of docs/CLAUDE.md",
  header: "| Rule | Bucket | Nearest pstack item | Origin |",
  allowed: [{ column: 1, values: BUCKETS }],
};

const TABLE_C: TableSpec = {
  heading: "## Table C: Lombakita commands, agents, skills and hooks",
  header: "| Lombakita item | Kind | Bucket | Nearest pstack item | Note |",
  allowed: [{ column: 2, values: BUCKETS }],
};

const cellsOf = (line: string): string[] =>
  line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());

const isSeparatorRow = (line: string): boolean =>
  line.startsWith("|") && cellsOf(line).every((cell) => /^-+$/.test(cell));

const skipBlankLines = (lines: readonly string[], from: number): number => {
  let at = from;
  while (lines[at]?.trim() === "") at += 1;
  return at;
};

const checkedRow = (
  line: string,
  spec: TableSpec,
  columnCount: number,
  earlierRows: readonly string[][],
): string[] => {
  const cells = cellsOf(line);
  const key = cells[0] ?? "";
  if (cells.length !== columnCount) {
    refuse(`row with the wrong number of cells in ${spec.heading}: ${key}`);
  }
  for (const { column, values } of spec.allowed) {
    const value = cells[column] ?? "";
    if (!values.includes(value))
      refuse(`value outside its allowed set in ${spec.heading}: ${value}`);
  }
  if (earlierRows.some((row) => row[0] === key)) {
    refuse(`repeated key in ${spec.heading}: ${key}`);
  }
  return cells;
};

const readTableRows = (lines: readonly string[], spec: TableSpec): string[][] => {
  const headingAt = lines.indexOf(spec.heading);
  if (headingAt === -1) return refuse(`table missing: ${spec.heading}`);
  const headerAt = skipBlankLines(lines, headingAt + 1);
  const separator = lines[headerAt + 1];
  if (lines[headerAt] !== spec.header || separator === undefined || !isSeparatorRow(separator)) {
    return refuse(`table missing: ${spec.heading}`);
  }
  const columnCount = cellsOf(spec.header).length;
  const rows: string[][] = [];
  for (let at = headerAt + 2; lines[at]?.startsWith("|"); at += 1) {
    rows.push(checkedRow(lines[at] ?? "", spec, columnCount, rows));
  }
  return rows;
};

const readAllowedMentions = (lines: readonly string[]): string[] => {
  const headingAt = lines.indexOf(ALLOWED_MENTIONS_HEADING);
  if (headingAt === -1) return [];
  const afterHeading = lines.slice(headingAt + 1);
  const nextHeadingAt = afterHeading.findIndex((line) => line.startsWith("#"));
  const section = nextHeadingAt === -1 ? afterHeading : afterHeading.slice(0, nextHeadingAt);
  return section.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
};

export const parseRegister = (registerText: string): Register => {
  const lines = splitLines(registerText);
  return {
    pstackItems: readTableRows(lines, TABLE_A).map((cells) => ({
      name: cells[0] ?? "",
      kind: cells[1] ?? "",
      status: cells[2] ?? "",
    })),
    rules: readTableRows(lines, TABLE_B).map((cells) => ({
      rule: cells[0] ?? "",
      origin: cells[3] ?? "",
    })),
    lombakitaItems: readTableRows(lines, TABLE_C).map((cells) => ({ item: cells[0] ?? "" })),
    allowedMentions: readAllowedMentions(lines),
  };
};

// ---------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------

const LOCK_LINE = /^([0-9a-fA-F]{64}) {2}(\.\/.+)$/;

/** The lock as path to lowercase sha256. A path listed twice is not "one line per file". */
export const parseLock = (lockText: string): Map<string, string> => {
  const lines = splitLines(lockText);
  if (lines[lines.length - 1] === "") lines.pop();
  const hashes = new Map<string, string>();
  lines.forEach((line, index) => {
    const match = LOCK_LINE.exec(line);
    const hash = match?.[1];
    const path = match?.[2];
    if (hash === undefined || path === undefined || hashes.has(path)) {
      refuse(`lock line not in the lock format: ${index + 1}`);
    }
    hashes.set(path, hash.toLowerCase());
  });
  return hashes;
};

// ---------------------------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------------------------

export interface FolderEntry {
  name: string;
  isFolder: boolean;
}

export interface LombakitaFolders {
  commands: FolderEntry[];
  agents: FolderEntry[];
  skills: FolderEntry[];
  hooks: FolderEntry[];
}

export interface RawInputs {
  registerText: string;
  modeText: string;
  lockText: string;
  claudeText: string;
  folders: LombakitaFolders;
}

function readInputFile(productRoot: string, relativePath: string): string {
  try {
    return readFileSync(join(productRoot, relativePath), "utf8");
  } catch (error) {
    if (isAbsent(error)) return refuse(`input file missing: ${relativePath}`);
    throw error;
  }
}

function readInputFolder(productRoot: string, relativePath: string): FolderEntry[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(productRoot, relativePath), { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return refuse(`input file missing: ${relativePath}`);
    throw error;
  }
  return entries.map((entry) => {
    if (entry.isDirectory()) return { name: entry.name, isFolder: true };
    if (entry.isFile()) return { name: entry.name, isFolder: false };
    return refuse(
      `entry that is neither a regular file nor a folder: ${relativePath}/${entry.name}`,
    );
  });
}

export const readInputs = (productRoot: string): RawInputs => ({
  registerText: readInputFile(productRoot, REGISTER_PATH),
  modeText: readInputFile(productRoot, MODE_PATH),
  lockText: readInputFile(productRoot, LOCK_PATH),
  claudeText: readInputFile(productRoot, CLAUDE_PATH),
  folders: {
    commands: readInputFolder(productRoot, FOLDER_PATHS.commands),
    agents: readInputFolder(productRoot, FOLDER_PATHS.agents),
    skills: readInputFolder(productRoot, FOLDER_PATHS.skills),
    hooks: readInputFolder(productRoot, FOLDER_PATHS.hooks),
  },
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

const folderItems = (
  folderPath: string,
  entries: readonly FolderEntry[],
  isItem: (entry: FolderEntry) => boolean,
): string[] =>
  entries
    .filter((entry) => entry.name !== VENDORED_LIST_FILE && isItem(entry))
    .map((entry) => `${folderPath}/${entry.name}`);

const isFileEnding = (ending: string) => (entry: FolderEntry) =>
  !entry.isFolder && entry.name.endsWith(ending);

const listLombakitaItems = (folders: LombakitaFolders): string[] => [
  ...folderItems(FOLDER_PATHS.commands, folders.commands, isFileEnding(".md")),
  ...folderItems(FOLDER_PATHS.agents, folders.agents, isFileEnding(".md")),
  ...folderItems(FOLDER_PATHS.skills, folders.skills, (entry) => entry.isFolder),
  ...folderItems(FOLDER_PATHS.hooks, folders.hooks, isFileEnding(".sh")),
];

export interface CheckInputs {
  register: Register;
  lock: ReadonlyMap<string, string>;
  installedHashes: ReadonlyMap<string, string>;
  installed: InstalledItems;
  modeText: string;
  ruleNumbers: string[];
  lombakitaItems: string[];
  homeFolder: string;
}

/** Parses and hashes everything the six checks read, in the order a refusal is listed. */
export const buildCheckInputs = (
  raw: RawInputs,
  installedPath: string,
  homeFolder: string,
): CheckInputs => ({
  register: parseRegister(raw.registerText),
  lock: parseLock(raw.lockText),
  installedHashes: hashTree(installedPath),
  installed: readInstalledItems(installedPath),
  modeText: raw.modeText,
  ruleNumbers: readRuleNumbers(raw.claudeText),
  lombakitaItems: listLombakitaItems(raw.folders),
  homeFolder,
});

// ---------------------------------------------------------------------------------------------
// The six checks. Each returns its failure lines; an empty array is a pass.
// ---------------------------------------------------------------------------------------------

const referencedSuffix = (path: string, register: Register): string => {
  const skillName = /^\.\/skills\/([^/]+)\//.exec(path)?.[1];
  const isAdopted = register.pstackItems.some(
    (row) => row.name === skillName && row.status === "ADOPT",
  );
  return isAdopted ? " (referenced)" : "";
};

export const checkDrift = (
  lock: ReadonlyMap<string, string>,
  installedHashes: ReadonlyMap<string, string>,
  register: Register,
): string[] => {
  const failures: string[] = [];
  for (const [path, lockedHash] of lock) {
    const installedHash = installedHashes.get(path);
    const suffix = referencedSuffix(path, register);
    if (installedHash === undefined) failures.push(`removed: ${path}${suffix}`);
    else if (installedHash !== lockedHash) failures.push(`changed: ${path}${suffix}`);
  }
  for (const path of installedHashes.keys()) {
    if (!lock.has(path)) failures.push(`added: ${path}${referencedSuffix(path, register)}`);
  }
  return sortedByText(failures);
};

const hasRow = (rows: readonly PstackItemRow[], name: string, kind: string): boolean =>
  rows.some((row) => row.name === name && row.kind === kind);

const unclassifiedPstackItems = (register: Register, installed: InstalledItems): string[] => [
  ...installed.skills
    .filter((skill) => !hasRow(register.pstackItems, skill.name, "skill"))
    .map((skill) => `pstack skill without a row: ${skill.name}`),
  ...installed.agents
    .filter((name) => !hasRow(register.pstackItems, name, "agent"))
    .map((name) => `pstack agent without a row: ${name}`),
];

const unclassifiedRules = (register: Register, ruleNumbers: readonly string[]): string[] => [
  ...ruleNumbers
    .filter((rule) => !register.rules.some((row) => row.rule === rule))
    .map((rule) => `rule without a row: ${rule}`),
  ...register.rules
    .filter((row) => !ruleNumbers.includes(row.rule))
    .map((row) => `rule row beyond the last rule: ${row.rule}`),
];

const unclassifiedLombakitaItems = (
  register: Register,
  lombakitaItems: readonly string[],
): string[] => [
  ...lombakitaItems
    .filter((item) => !register.lombakitaItems.some((row) => row.item === item))
    .map((item) => `Lombakita item without a row: ${item}`),
  ...register.lombakitaItems
    .filter((row) => !row.item.startsWith("user level:") && !lombakitaItems.includes(row.item))
    .map((row) => `row for a Lombakita item that does not exist: ${row.item}`),
];

export const checkUnclassified = (
  register: Register,
  installed: InstalledItems,
  ruleNumbers: readonly string[],
  lombakitaItems: readonly string[],
): string[] =>
  sortedByText([
    ...unclassifiedPstackItems(register, installed),
    ...unclassifiedRules(register, ruleNumbers),
    ...unclassifiedLombakitaItems(register, lombakitaItems),
  ]);

export const checkPointer = (register: Register, installed: InstalledItems): string[] => {
  const installedSkills = installed.skills.map((skill) => skill.name);
  const failures = register.pstackItems
    .filter((row) => {
      const installedNames = row.kind === "skill" ? installedSkills : installed.agents;
      return !installedNames.includes(row.name);
    })
    .map((row) => `register names a pstack ${row.kind} that is not installed: ${row.name}`);
  return sortedByText(failures);
};

export const checkFlag = (register: Register, installed: InstalledItems): string[] => {
  const failures = installed.skills
    .filter((skill) => skill.modelInvocable)
    .filter((skill) => {
      const row = register.pstackItems.find((r) => r.name === skill.name && r.kind === "skill");
      return row?.status !== "FORBIDDEN";
    })
    .map((skill) => `skill is model-invocable and not FORBIDDEN: ${skill.name}`);
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

export const checkFailureBorn = (register: Register, modeText: string): string[] => {
  const failures = register.rules
    .filter((row) => row.origin !== "none")
    .filter((row) => !modeNamesRule(modeText, row.rule))
    .map((row) => `rule ${row.rule} has an origin and the mode does not name Rule ${row.rule}`);
  return sortedByText(failures);
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
  {
    name: "drift",
    failures: checkDrift(inputs.lock, inputs.installedHashes, inputs.register),
  },
  {
    name: "unclassified",
    failures: checkUnclassified(
      inputs.register,
      inputs.installed,
      inputs.ruleNumbers,
      inputs.lombakitaItems,
    ),
  },
  { name: "pointer", failures: checkPointer(inputs.register, inputs.installed) },
  { name: "flag", failures: checkFlag(inputs.register, inputs.installed) },
  { name: "failure-born", failures: checkFailureBorn(inputs.register, inputs.modeText) },
  { name: "leak", failures: checkLeak(inputs.homeFolder, inputs.register.allowedMentions) },
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
