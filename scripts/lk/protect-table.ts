/**
 * The protect-file hook's answer table: each row is one hook call with the exit code, the streams
 * and the governance-log lines the script must produce. The rows are run through the script itself,
 * as Claude Code runs a PreToolUse hook (`bash <script>` with the tool call as JSON on standard
 * input), against a throwaway project root built here. The script reads the file system and never
 * runs a command, so the root holds only the structure the rows name.
 *
 * Each row carries `tags` naming the elements of the script it exercises, which the mutation proofs
 * in deny-proof.test.ts use to say which rows an element governs.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Role = "implementer" | "controller" | "unset" | "reviewer";
type RootKind = "main" | "bare" | "script" | "script-docs";

const BLOCK_HEADING = "PROTECTED PATH WRITE BLOCKED: ";
const GRANT_NEEDED = "A governance grant is needed to write this path.";
const NO_GRANT_GIT = "No governance grant can cover a path under .git.";
const NO_GRANT_FOLDER = "No governance grant can cover this folder.";
const GRANT_IGNORED = "was ignored";
const REFUSAL_HEADING = "PROTECTED PATH HOOK REFUSED";
const LOG_FILE = "governance-log.txt";
const CONTROLLER_WARNING = "PROTECTED FILE EDIT DETECTED";
const LOG_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (ALLOWED|BLOCKED) (Edit|Write|MultiEdit|Bash) (.+)$/;
const SCRIPT_NAME = "check-protected-file.sh";
const ZONE_FAR_FROM_UTC = "Pacific/Kiritimati";
const MAX_LOG_CLOCK_SKEW_MS = 300_000;
const TARGET_CAP = 20_000;
const PATCH_BYTE_CAP = 4_000_000;
const ROW_CONCURRENCY = 10;
const ROW_TIMEOUT_MS = 30_000;

export interface RowContext {
  /** The real path of the folder holding every root of the fixture. */
  base: string;
  root: string;
  slug: string;
}

export interface ProtectRow {
  id: string;
  tags: string[];
  role: Role;
  /** LK_SLUG; the default is one slug per row, null leaves it unset. */
  slug: string | null;
  /** LK_GOVERNANCE_GRANT; null leaves it unset. */
  grant: string | null;
  root: RootKind;
  extraEnv: Record<string, string>;
  input: (context: RowContext) => string;
  exit: 0 | 2;
  stdout: "empty" | "warning";
  /** Substrings of standard error; an exit 0 row must leave standard error empty. */
  stderr: (context: RowContext) => string[];
  /** Substrings that standard error must not hold. */
  stderrNot: string[];
  /** The log lines, without their timestamps, in order; none means no log file exists. */
  logged: (context: RowContext) => string[];
  /** Runs after the slug folder exists and before the hook. */
  prepare?: (context: RowContext) => void;
  /** Returns a problem text when the state after the hook is wrong. */
  after?: (context: RowContext) => string | undefined;
  /** Whether the row creates the .work/<slug> folder; the default is yes when a slug is set. */
  slugFolder: boolean;
  /** The log path holds something the row planted, so the row checks the state itself in `after`. */
  ignoreLog: boolean;
  /** The row kills the script after this long; the default is ROW_TIMEOUT_MS. */
  timeoutMs: number;
  /** The row fails when the script took longer than this; the default is no limit. */
  maxMs: number | null;
  /** The folder the script runs in; the default is the folder that holds every root of the fixture. */
  workingFolder: (context: RowContext) => string;
}

export type RowSpec = Partial<Omit<ProtectRow, "id" | "tags" | "input">> & {
  tags?: string[];
  input: ProtectRow["input"] | string;
};

const slugLetters = (index: number): string => {
  let letters = "";
  let rest = index;
  do {
    letters = String.fromCharCode(97 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return `row-${letters}`;
};

const payload = (tool: string, toolInput: Record<string, unknown>, cwd?: string): string =>
  JSON.stringify({ tool_name: tool, tool_input: toolInput, ...(cwd === undefined ? {} : { cwd }) });

const fileCall = (tool: string, path: string, cwd?: string): string =>
  payload(tool, { file_path: path }, cwd);

const bashCall = (command: string, cwd?: string): string => payload("Bash", { command }, cwd);

const blockMessage = (shown: string, slug: string): string[] => {
  const underGit = shown.split("/").some((part) => part.toLowerCase() === ".git");
  const folder = shown === "." || shown === "docs" || shown.startsWith("/");
  if (underGit) return [`${BLOCK_HEADING}${shown}`, NO_GRANT_GIT];
  if (folder) return [`${BLOCK_HEADING}${shown}`, NO_GRANT_FOLDER];
  return [
    `${BLOCK_HEADING}${shown}`,
    GRANT_NEEDED,
    `governance-grant: ${shown}`,
    `.work/${slug}/01-spec.md`,
  ];
};

/** The refusal of an ancestor names the folder with a trailing slash, the form a folder grant takes. */
const ancestorBlockMessage = (shown: string, slug: string): string[] =>
  blockMessage(shown, slug).map((text) =>
    text.startsWith("governance-grant: ") ? `${text}/` : text,
  );

const shownOf = (line: string): string => line.split(" ").slice(2).join(" ");

const MAC_DATA_VOLUME = "/System/Volumes/Data";
const TEMP_ROOT = realpathSync(tmpdir());
const TEMP_ROOT_UNDER_PRIVATE = TEMP_ROOT.startsWith("/private/");

const withoutPrivate = (path: string): string =>
  path.startsWith("/private/") ? path.slice("/private".length) : path;
const withPrivate = (path: string): string =>
  path.startsWith("/private/") ? path : `/private${path}`;
const togglePrivate = (path: string): string =>
  path.startsWith("/private/") ? withoutPrivate(path) : withPrivate(path);

/** The spelling the hook shows for a path outside the product root: the aliases of the disk are off the front. */
const shownOutside = (path: string): string => withoutPrivate(path);

const resolveBase = (text: string, context: RowContext): string =>
  text
    .replaceAll("<base>", shownOutside(context.base))
    .replaceAll("<root>", shownOutside(context.root));

/** The default expectations: the rows of a blocked call print its refusal, and an allowed one is silent. */
export const buildRow = (id: string, index: number, spec: RowSpec): ProtectRow => {
  const rawLogged = spec.logged ?? (() => []);
  const logged = (context: RowContext): string[] =>
    rawLogged(context).map((line) => resolveBase(line, context));
  const exit = spec.exit ?? 0;
  const stderr =
    spec.stderr ??
    ((context: RowContext) => {
      const first = logged(context)[0];
      if (exit !== 2 || first === undefined || !first.startsWith("BLOCKED")) return [];
      return blockMessage(shownOf(first), context.slug);
    });
  const input = spec.input;
  const tags = spec.tags ?? [];
  const grantEntryIgnored = tags.includes("grant-entry");
  return {
    id,
    tags,
    role: spec.role ?? "implementer",
    slug: spec.slug === undefined ? slugLetters(index) : spec.slug,
    grant: spec.grant ?? null,
    root: spec.root ?? "main",
    extraEnv: spec.extraEnv ?? {},
    input: typeof input === "string" ? () => input : input,
    exit,
    stdout: spec.stdout ?? "empty",
    stderr,
    stderrNot: spec.stderrNot ?? (exit === 2 && !grantEntryIgnored ? [GRANT_IGNORED] : []),
    logged,
    prepare: spec.prepare,
    after: spec.after,
    slugFolder: spec.slugFolder ?? true,
    ignoreLog: spec.ignoreLog ?? false,
    timeoutMs: spec.timeoutMs ?? ROW_TIMEOUT_MS,
    maxMs: spec.maxMs ?? null,
    workingFolder: spec.workingFolder ?? ((context) => context.base),
  };
};

// ---- the protected paths the matrix rows run through every write form --------------------------

interface ProtectedPath {
  path: string;
  shown: string;
  entry: string;
}

export const PROTECTED_PATHS: readonly ProtectedPath[] = [
  { path: "docs/project/SSOT.md", shown: "docs/project/SSOT.md", entry: "ssot" },
  {
    path: "docs/product/state-machines.md",
    shown: "docs/product/state-machines.md",
    entry: "state-machines",
  },
  {
    path: "docs/product/contracts/x.yaml",
    shown: "docs/product/contracts/x.yaml",
    entry: "product-contracts",
  },
  {
    path: "docs/contracts/x.yaml",
    shown: "docs/product/contracts/x.yaml",
    entry: "product-contracts",
  },
  { path: "docs/.claude/hooks/x.sh", shown: "docs/.claude/hooks/x.sh", entry: "claude-folder" },
  {
    path: "docs/.claude/settings.json",
    shown: "docs/.claude/settings.json",
    entry: "claude-folder",
  },
  { path: "docs/CLAUDE.md", shown: "docs/CLAUDE.md", entry: "claude-md" },
  {
    path: "docs/CLAUDE-reference.md",
    shown: "docs/CLAUDE-reference.md",
    entry: "claude-reference",
  },
  { path: "docs/AGENTS.md", shown: "docs/AGENTS.md", entry: "agents" },
  { path: "docs/project/controller.md", shown: "docs/project/controller.md", entry: "controller" },
  {
    path: "docs/product/ui-preferences.md",
    shown: "docs/product/ui-preferences.md",
    entry: "ui-preferences",
  },
  { path: "docs/project/models.md", shown: "docs/project/models.md", entry: "models" },
  { path: ".git/hooks/pre-commit", shown: ".git/hooks/pre-commit", entry: "git" },
  { path: "docs/.git/config", shown: "docs/.git/config", entry: "docs-git" },
];

const WRITE_FORMS: { form: string; command: (path: string) => string }[] = [
  { form: "redirect", command: (path) => `echo x > ${path}` },
  { form: "cp", command: (path) => `cp a.txt ${path}` },
  { form: "mv", command: (path) => `mv a.txt ${path}` },
  { form: "rm", command: (path) => `rm ${path}` },
  { form: "ln", command: (path) => `ln -s a.txt ${path}` },
  { form: "install", command: (path) => `install a.txt ${path}` },
  { form: "rsync", command: (path) => `rsync a.txt ${path}` },
];

const ROOT_SPELLINGS_OF_LINKS = [
  { path: "CLAUDE.md", shown: "docs/CLAUDE.md", entry: "claude-md" },
  { path: "AGENTS.md", shown: "docs/AGENTS.md", entry: "agents" },
  { path: ".claude/settings.json", shown: "docs/.claude/settings.json", entry: "claude-folder" },
];

export type Spec = [id: string, spec: RowSpec];

const blockedLog =
  (tool: string, shown: string): (() => string[]) =>
  () => [`BLOCKED ${tool} ${shown}`];
const allowedLog =
  (tool: string, shown: string): (() => string[]) =>
  () => [`ALLOWED ${tool} ${shown}`];

const matrixSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  for (const { path, shown, entry } of PROTECTED_PATHS) {
    const git = entry === "git" || entry === "docs-git";
    const base = [
      "matrix",
      `entry:${entry}`,
      ...(git ? ["git"] : []),
      ...(path.startsWith("docs/.claude") || path.includes("contracts/") ? ["folder-match"] : []),
      ...(path.startsWith("docs/contracts/") ? ["realpath"] : []),
    ];
    for (const tool of ["Edit", "Write"]) {
      specs.push([
        `${tool} ${path}`,
        {
          tags: [...base, `tool:${tool}`],
          input: fileCall(tool, path),
          exit: 2,
          logged: blockedLog(tool, shown),
        },
      ]);
    }
    for (const { form, command } of WRITE_FORMS) {
      specs.push([
        `${form} ${path}`,
        {
          tags: [...base, `verb:${form}`],
          input: bashCall(command(path)),
          exit: 2,
          logged: blockedLog("Bash", shown),
        },
      ]);
    }
  }
  for (const { path, shown, entry } of [
    PROTECTED_PATHS[0],
    PROTECTED_PATHS[1],
    PROTECTED_PATHS[2],
  ] as ProtectedPath[]) {
    specs.push([
      `MultiEdit ${path}`,
      {
        tags: ["matrix", `entry:${entry}`, "tool:MultiEdit"],
        input: fileCall("MultiEdit", path),
        exit: 2,
        logged: blockedLog("MultiEdit", shown),
      },
    ]);
  }
  for (const { path, shown, entry } of ROOT_SPELLINGS_OF_LINKS) {
    specs.push([
      `Write ${path} through a product-root link`,
      {
        tags: ["realpath", `entry:${entry}`],
        input: fileCall("Write", path),
        exit: 2,
        logged: blockedLog("Write", shown),
      },
    ]);
    specs.push([
      `redirect to ${path} through a product-root link`,
      {
        tags: ["realpath", `entry:${entry}`],
        input: bashCall(`echo x > ${path}`),
        exit: 2,
        logged: blockedLog("Bash", shown),
      },
    ]);
  }
  return specs;
};

const readOnlySpecs = (): Spec[] =>
  PROTECTED_PATHS.flatMap(({ path }): Spec[] => [
    [`cat ${path}`, { tags: ["read"], input: bashCall(`cat ${path}`) }],
    [`grep in ${path}`, { tags: ["read"], input: bashCall(`grep x ${path}`) }],
  ]);

const allowedControlSpecs = (): Spec[] => {
  const files = [
    ".github/workflows/x.yml",
    ".gitignore",
    ".gitattributes",
    "notes.txt",
    "docs/project/BACKLOG.md",
    "docs/project/NOTES.md",
    "docs/product/other.md",
    "docs/Project2/x.md",
  ];
  const specs: Spec[] = [];
  for (const path of files) {
    specs.push([`Edit ${path} is allowed`, { tags: ["control"], input: fileCall("Edit", path) }]);
    specs.push([`Write ${path} is allowed`, { tags: ["control"], input: fileCall("Write", path) }]);
    specs.push([
      `redirect to ${path} is allowed`,
      { tags: ["control"], input: bashCall(`echo x > ${path}`) },
    ]);
  }
  return specs;
};

const utcStamp = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

const logFileSpecs = (): Spec[] => [
  [
    "Edit of the governance log itself is allowed",
    {
      tags: ["control"],
      input: (context) => fileCall("Edit", `.work/${context.slug}/governance-log.txt`),
    },
  ],
  [
    "redirect to the governance log itself is allowed",
    {
      tags: ["control"],
      input: (context) => bashCall(`echo x >> .work/${context.slug}/governance-log.txt`),
    },
  ],
];

const gitProgramSpecs = (): Spec[] => [
  [
    "git commit is not examined",
    { tags: ["control", "git-program"], input: bashCall('git commit -m "x"') },
  ],
  [
    "git add is not examined",
    { tags: ["control", "git-program"], input: bashCall("git add docs/project/SSOT.md") },
  ],
  [
    "git push is not examined",
    { tags: ["control", "git-program"], input: bashCall("git push origin main") },
  ],
  [
    "a commit message heredoc with an apostrophe is parsed and allowed",
    {
      tags: ["control", "heredoc"],
      input: bashCall("git commit -m \"$(cat <<'EOF'\ndon't\nEOF\n)\""),
    },
  ],
  [
    "a quoted redirect operator inside a string is not a redirect",
    { tags: ["control", "quotes"], input: bashCall('echo "x > docs/project/SSOT.md"') },
  ],
  [
    "a heredoc body is not scanned as commands",
    {
      tags: ["control", "heredoc", "heredoc:body"],
      input: bashCall("cat > notes.txt <<'EOF'\nrm docs/project/SSOT.md\nEOF"),
    },
  ],
  [
    "a redirect to /dev/null is allowed",
    { tags: ["control"], input: bashCall("ls > /dev/null 2>&1") },
  ],
  [
    "a copy of a protected file out of the tree is allowed",
    { tags: ["control"], input: bashCall("cp docs/project/SSOT.md notes.txt") },
  ],
];

const ancestorSpecs = (): Spec[] => {
  const blocked = (
    id: string,
    command: string,
    shown: string,
    tags: string[],
    cwd?: string,
  ): Spec => [
    id,
    {
      tags: [
        "ancestor",
        "ancestor:entry",
        ...(shown === "docs" || shown === "." ? ["ancestor:holds-git"] : []),
        ...tags,
      ],
      input: bashCall(command, cwd),
      exit: 2,
      logged: blockedLog("Bash", shown),
      stderr: (c) => ancestorBlockMessage(shown, c.slug),
    },
  ];
  const blockedFile = (id: string, command: string, shown: string, tags: string[]): Spec => [
    id,
    { tags, input: bashCall(command), exit: 2, logged: blockedLog("Bash", shown) },
  ];
  const allowed = (id: string, command: string, tags: string[] = []): Spec => [
    id,
    { tags: ["control", ...tags], input: bashCall(command) },
  ];
  return [
    allowed("cp a.txt . is allowed", "cp a.txt ."),
    allowed("rm notes.txt is allowed", "rm notes.txt"),
    allowed("mv a.txt b.txt is allowed", "mv a.txt b.txt", ["ancestor:unprotected-folder"]),
    allowed("cp -r src/ dist/ is allowed", "cp -r src/ dist/", ["ancestor:unprotected-folder"]),
    allowed("rm -rf dist is allowed", "rm -rf dist", ["ancestor:unprotected-folder"]),
    allowed("rm -r src is allowed", "rm -r src", ["ancestor:unprotected-folder"]),
    allowed("rm -rf docs/notes is allowed", "rm -rf docs/notes", ["ancestor:docs-sibling"]),
    allowed("cp -r src/ docs/notes/ is allowed", "cp -r src/ docs/notes/", [
      "ancestor:docs-sibling",
    ]),
    allowed("mv a.txt docs/notes is allowed", "mv a.txt docs/notes", ["ancestor:docs-sibling"]),
    allowed("rsync -a build/ dist/ is allowed", "rsync -a build/ dist/", [
      "ancestor:unprotected-folder",
    ]),
    allowed("rsync to a remote host is allowed", "rsync -a build/ host:/srv/"),
    allowed("install -d dist is allowed", "install -d dist", ["ancestor:unprotected-folder"]),
    allowed("a non-recursive cp into docs writes only the file it names", "cp a.txt docs/", [
      "nonrecursive-dest",
    ]),
    allowed(
      "a non-recursive cp into docs/project writes only the file it names",
      "cp a.txt docs/project/",
      ["nonrecursive-dest"],
    ),
    allowed(
      "a non-recursive install into docs/project writes only the file it names",
      "install a.txt docs/project/",
      ["nonrecursive-dest"],
    ),
    allowed(
      "a non-recursive ln into docs/project writes only the file it names",
      "ln -s a.txt docs/project/",
      ["nonrecursive-dest"],
    ),
    allowed(
      "a non-recursive rsync into docs/project writes only the file it names",
      "rsync a.txt docs/project/",
      ["nonrecursive-dest"],
    ),
    blockedFile(
      "cp of a file named SSOT.md into docs/project/ writes the protected file",
      "cp SSOT.md docs/project/",
      "docs/project/SSOT.md",
      ["nonrecursive-dest", "verb:cp", "entry:ssot"],
    ),
    blockedFile(
      "install of a file named SSOT.md into docs/project/ writes the protected file",
      "install SSOT.md docs/project/",
      "docs/project/SSOT.md",
      ["nonrecursive-dest", "verb:install", "entry:ssot"],
    ),
    blockedFile(
      "ln of a file named SSOT.md into docs/project/ writes the protected file",
      "ln -s SSOT.md docs/project/",
      "docs/project/SSOT.md",
      ["nonrecursive-dest", "verb:ln", "entry:ssot"],
    ),
    blockedFile(
      "rsync of a file named SSOT.md into docs/project/ writes the protected file",
      "rsync SSOT.md docs/project/",
      "docs/project/SSOT.md",
      ["nonrecursive-dest", "verb:rsync", "entry:ssot"],
    ),
    blockedFile(
      "cp of a file named SSOT.md into docs/project with no trailing slash writes the protected file",
      "cp SSOT.md docs/project",
      "docs/project/SSOT.md",
      ["nonrecursive-dest:no-slash", "verb:cp", "entry:ssot"],
    ),
    blocked("mv docs/project elsewhere", "mv docs/project elsewhere", "docs/project", [
      "ancestor:mv",
    ]),
    blocked("mv docs elsewhere", "mv docs elsewhere", "docs", ["ancestor:mv"]),
    blocked("mv . elsewhere (the product root)", "mv . elsewhere", ".", [
      "ancestor:mv",
      "ancestor:root",
    ]),
    blocked("mv a.txt into docs/ names the docs folder as an operand", "mv a.txt docs/", "docs", [
      "ancestor:mv",
    ]),
    blocked(
      "mv -t docs/product moves into an ancestor",
      "mv -t docs/product a.txt",
      "docs/product",
      ["ancestor:mv", "mv:target-directory"],
    ),
    blocked("rm -r docs", "rm -r docs", "docs", ["ancestor:rm"]),
    blocked("rm -rf docs/project", "rm -rf docs/project", "docs/project", ["ancestor:rm"]),
    blocked("rm -R docs/product", "rm -R docs/product", "docs/product", ["ancestor:rm"]),
    blocked("rm --recursive docs", "rm --recursive docs", "docs", ["ancestor:rm"]),
    blocked("rm -d docs", "rm -d docs", "docs", ["ancestor:rm"]),
    blocked("rm docs, a folder, with no flag", "rm docs", "docs", ["ancestor:rm", "ancestor:dir"]),
    blocked("rm -rf . (the product root)", "rm -rf .", ".", ["ancestor:rm", "ancestor:root"]),
    blocked("cp -r src/ docs/", "cp -r src/ docs/", "docs", ["ancestor:cp"]),
    blocked("cp -R src docs/product/", "cp -R src docs/product/", "docs/product", ["ancestor:cp"]),
    blocked("cp -a src docs/project", "cp -a src docs/project", "docs/project", ["ancestor:cp"]),
    blocked("cp --recursive src docs", "cp --recursive src docs", "docs", ["ancestor:cp"]),
    blocked("cp -r src/ . (the product root)", "cp -r src/ .", ".", [
      "ancestor:cp",
      "ancestor:root",
    ]),
    blocked("install -d docs", "install -d docs", "docs", ["ancestor:install"]),
    blocked("rsync -a build/ docs/", "rsync -a build/ docs/", "docs", ["ancestor:rsync"]),
    blocked("rsync -a build/ docs/project/", "rsync -a build/ docs/project/", "docs/project", [
      "ancestor:rsync",
    ]),
    blocked("rsync --recursive src docs", "rsync --recursive src docs", "docs", ["ancestor:rsync"]),
    blocked("rsync -a build/ . (the product root)", "rsync -a build/ .", ".", [
      "ancestor:rsync",
      "ancestor:root",
    ]),
    blocked(
      "rsync -a --exclude x build/ docs/ consumes the value of --exclude",
      "rsync -a --exclude x build/ docs/",
      "docs",
      ["ancestor:rsync"],
    ),
    blocked(
      "rsync with an option value after the destination",
      "rsync -a build/ docs/ --exclude x",
      "docs",
      ["ancestor:rsync", "rsync:option-value"],
    ),
    blocked("cp -va src docs/product/", "cp -va src docs/product/", "docs/product", [
      "ancestor:cp",
      "options:combined",
    ]),
    blocked("rsync -avz src docs/product/", "rsync -avz src docs/product/", "docs/product", [
      "ancestor:rsync",
    ]),
    [
      "rm -rf of a protected ancestor that does not exist is still refused",
      {
        tags: ["ancestor", "ancestor:entry", "rm:recursive"],
        root: "bare",
        input: bashCall("rm -rf docs/project"),
        exit: 2,
        logged: blockedLog("Bash", "docs/project"),
        stderr: (c) => [
          `${BLOCK_HEADING}docs/project`,
          GRANT_NEEDED,
          "governance-grant: docs/project/",
          `.work/${c.slug}/01-spec.md`,
        ],
      },
    ],
    [
      "rm of a protected ancestor that does not exist and has no flag is allowed",
      {
        tags: ["control", "ancestor:dir-missing"],
        root: "bare",
        input: bashCall("rm docs/project"),
      },
    ],
    [
      "rm -rf of the folder above the product root",
      {
        tags: ["ancestor", "ancestor:above-root"],
        input: (c) => bashCall("rm -rf ..", c.root),
        exit: 2,
        logged: () => ["BLOCKED Bash <base>"],
      },
    ],
    [
      "rm -rf of a checkout elsewhere that holds a .git",
      {
        tags: ["ancestor", "ancestor:git-child:outside"],
        input: (c) => bashCall("rm -rf ../other", c.root),
        exit: 2,
        logged: () => ["BLOCKED Bash <base>/other"],
      },
    ],
    [
      "rm -rf of the file-system root",
      {
        tags: ["ancestor", "ancestor:above-root"],
        input: bashCall("rm -rf /"),
        exit: 2,
        logged: () => ["BLOCKED Bash /"],
      },
    ],
    [
      "rm -rf of a plain folder elsewhere with no .git",
      {
        tags: ["control", "ancestor:plain-folder"],
        input: (c) => bashCall("rm -rf ../outside", c.root),
      },
    ],
    [
      "rm -rf of a nested checkout inside the product root",
      {
        tags: ["ancestor", "ancestor:git-child:inside"],
        input: bashCall("rm -rf nested"),
        exit: 2,
        logged: blockedLog("Bash", "nested"),
        stderr: (c) => [
          `${BLOCK_HEADING}nested`,
          GRANT_NEEDED,
          "governance-grant: nested/",
          `.work/${c.slug}/01-spec.md`,
        ],
      },
    ],
    blockedFile(
      "mv of the docs/contracts link names the protected folder itself",
      "mv docs/contracts elsewhere",
      "docs/product/contracts",
      ["verb:mv", "realpath", "entry:product-contracts"],
    ),
  ];
};

const gitFolderSpecs = (): Spec[] => {
  const blocked = (id: string, command: string, shown: string, tags: string[]): Spec => [
    id,
    {
      tags: ["git", ...tags],
      input: bashCall(command),
      exit: 2,
      logged: blockedLog("Bash", shown),
    },
  ];
  return [
    blocked("rm -rf .git", "rm -rf .git", ".git", ["verb:rm"]),
    blocked("mv .git elsewhere", "mv .git elsewhere", ".git", ["verb:mv"]),
    blocked("truncate -s 0 .git/index", "truncate -s 0 .git/index", ".git/index", [
      "verb:truncate",
    ]),
    blocked("tee to .git/config", "echo x | tee .git/config", ".git/config", ["verb:tee"]),
    blocked("dd of= .git/config", "dd if=a.txt of=.git/config", ".git/config", ["verb:dd"]),
    blocked("sed -i on .git/config", "sed -i '' s/a/b/ .git/config", ".git/config", [
      "verb:sed",
      "sed:short",
    ]),
    blocked(
      "redirect to .git/config with a stderr redirect before it",
      "echo x 2>&1 > .git/config",
      ".git/config",
      ["verb:redirect"],
    ),
    blocked("cp into the docs repo's .git", "cp a.txt docs/.git/HEAD", "docs/.git/HEAD", [
      "verb:cp",
    ]),
    blocked(
      "redirect to .GIT/config in another letter case",
      "echo x > .GIT/config",
      ".GIT/config",
      ["fold"],
    ),
    [
      "cp into another checkout's .git",
      {
        tags: ["git", "git:outside"],
        input: (c) => bashCall("cp a.txt ../other/.git/config", c.root),
        exit: 2,
        logged: () => ["BLOCKED Bash <base>/other/.git/config"],
      },
    ],
    [
      "Write to another checkout's .git",
      {
        tags: ["git", "git:outside"],
        input: fileCall("Write", "../other/.git/config"),
        exit: 2,
        logged: () => ["BLOCKED Write <base>/other/.git/config"],
      },
    ],
    ["cat of .git/config is allowed", { tags: ["read"], input: bashCall("cat .git/config") }],
    [
      "cp a file to .gitignore is allowed",
      { tags: ["control"], input: bashCall("cp a.txt .gitignore") },
    ],
    [
      "cp a file to .github/x.yml is allowed",
      { tags: ["control"], input: bashCall("cp a.txt .github/x.yml") },
    ],
    [
      "cp a file to .gitattributes is allowed",
      { tags: ["control"], input: bashCall("cp a.txt .gitattributes") },
    ],
    [
      "cp a file to .git-keep is allowed",
      { tags: ["control"], input: bashCall("cp a.txt .git-keep") },
    ],
  ];
};

export const BASH_WRITE_FORM_ROWS = ["tee", "truncate", "dd", "sed"];

const bashFormSpecs = (): Spec[] => {
  const blocked = (
    id: string,
    command: string,
    tags: string[],
    cwd?: string,
    shown = "docs/project/SSOT.md",
  ): Spec => [
    id,
    {
      tags: ["bash", "entry:ssot", ...tags],
      input: (c) =>
        bashCall(
          command,
          cwd === "root" ? c.root : cwd === "docs-project" ? join(c.root, "docs/project") : cwd,
        ),
      exit: 2,
      logged: blockedLog("Bash", shown),
    },
  ];
  const allowed = (id: string, command: string, tags: string[] = [], cwd?: string): Spec => [
    id,
    {
      tags: ["control", ...tags],
      input: (c) =>
        bashCall(
          command,
          cwd === "root" ? c.root : cwd === "docs-project" ? join(c.root, "docs/project") : cwd,
        ),
    },
  ];
  return [
    blocked("tee to a protected file", "echo x | tee docs/project/SSOT.md", ["verb:tee"]),
    blocked("tee -a to a protected file", "echo x | tee -a notes.txt docs/project/SSOT.md", [
      "verb:tee",
    ]),
    allowed("tee to an unprotected file", "echo x | tee notes.txt", ["verb:tee"]),
    blocked("truncate -s 0 of a protected file", "truncate -s 0 docs/project/SSOT.md", [
      "verb:truncate",
    ]),
    blocked(
      "truncate with a reference file names the protected operand",
      "truncate -r a.txt docs/project/SSOT.md",
      ["verb:truncate"],
    ),
    allowed("truncate of an unprotected file", "truncate -s 0 notes.txt", ["verb:truncate"]),
    allowed(
      "truncate with a protected reference file only reads it",
      "truncate -r docs/project/SSOT.md notes.txt",
      ["verb:truncate", "truncate:reference"],
    ),
    blocked("dd of= a protected file", "dd if=a.txt of=docs/project/SSOT.md", ["verb:dd"]),
    allowed("dd reading a protected file", "dd if=docs/project/SSOT.md of=notes.txt", ["verb:dd"]),
    blocked("sed -i '' on a protected file", "sed -i '' s/a/b/ docs/project/SSOT.md", [
      "verb:sed",
      "sed:short",
    ]),
    blocked("sed -i.bak on a protected file", "sed -i.bak s/a/b/ docs/project/SSOT.md", [
      "verb:sed",
      "sed:short",
    ]),
    blocked("sed --in-place on a protected file", "sed --in-place s/a/b/ docs/project/SSOT.md", [
      "verb:sed",
      "sed:long",
    ]),
    blocked("sed -e with -i on a protected file", "sed -e s/a/b/ -i docs/project/SSOT.md", [
      "verb:sed",
      "sed:short",
    ]),
    blocked("sed -ni on a protected file", "sed -ni p docs/project/SSOT.md", [
      "verb:sed",
      "sed:short",
    ]),
    allowed(
      "a sed -e script that spells a protected path is not a write target",
      "sed -i -e docs/project/SSOT.md notes.txt",
      ["verb:sed", "sed:script-value"],
    ),
    allowed("sed -n without -i only reads", "sed -n p docs/project/SSOT.md", [
      "verb:sed",
      "sed:read",
    ]),
    allowed("sed -i on an unprotected file", "sed -i '' s/a/b/ notes.txt", ["verb:sed"]),
    blocked("append redirect", "echo x >> docs/project/SSOT.md", ["verb:redirect"]),
    blocked("clobber redirect", "echo x >| docs/project/SSOT.md", ["verb:redirect"]),
    blocked("redirect of both streams", "echo x &> docs/project/SSOT.md", ["verb:redirect"]),
    blocked("stderr redirect", "ls 2> docs/project/SSOT.md", ["verb:redirect"]),
    blocked("redirect with no space before the path", "echo x>docs/project/SSOT.md", [
      "verb:redirect",
    ]),
    blocked(
      "redirect after a command with a stderr dup",
      "cat a.txt > docs/project/SSOT.md 2>/dev/null",
      ["verb:redirect"],
    ),
    blocked("redirect to a quoted path", 'echo x > "docs/project/SSOT.md"', ["verb:redirect"]),
    blocked("redirect after a pipe", "echo x | cat > docs/project/SSOT.md", ["verb:redirect"]),
    blocked("redirect after &&", "true && echo x > docs/project/SSOT.md", ["segments"]),
    blocked("redirect after ;", "true; echo x > docs/project/SSOT.md", ["segments"]),
    blocked("redirect after ||", "false || echo x > docs/project/SSOT.md", ["segments"]),
    blocked("redirect on a second line", "true\necho x > docs/project/SSOT.md", ["segments"]),
    blocked("redirect after a heredoc", "cat <<'EOF' > docs/project/SSOT.md\nit's\nEOF", [
      "heredoc",
    ]),
    blocked("redirect after a comment line", "# a note\necho x > docs/project/SSOT.md", [
      "segments",
    ]),
    blocked("a comment holding an apostrophe is skipped", "# don't\nrm docs/project/SSOT.md", [
      "segments",
      "comment",
    ]),
    blocked("a write on the line after a trailing comment", "ls # note\nrm docs/project/SSOT.md", [
      "segments",
      "segments:newline",
    ]),
    blocked("rm after &&", "true && rm docs/project/SSOT.md", ["segments", "segments:verb"]),
    blocked("rm after ;", "true; rm docs/project/SSOT.md", ["segments", "segments:verb"]),
    blocked("rm after ||", "false || rm docs/project/SSOT.md", ["segments", "segments:verb"]),
    blocked("rm after a pipe", "echo x | rm docs/project/SSOT.md", ["segments", "segments:verb"]),
    blocked("rm on a second line", "true\nrm docs/project/SSOT.md", [
      "segments",
      "segments:verb",
      "segments:newline",
    ]),
    blocked(
      "rm after a heredoc whose body holds an apostrophe",
      "cat <<'EOF'\nit's\nEOF\nrm docs/project/SSOT.md",
      ["heredoc", "heredoc:body", "segments:newline"],
    ),
    blocked("rm in a command substitution", "echo $(rm docs/project/SSOT.md)", [
      "segments",
      "segments:verb",
    ]),
    blocked("rm in backticks", "echo `rm docs/project/SSOT.md`", ["backtick"]),
    blocked(
      "a redirect of file descriptor 2 in front of the command",
      "2>/dev/null rm docs/project/SSOT.md",
      ["redirect:fd-prefix"],
    ),
    allowed(
      "an input redirect operand is not a write target",
      "tee notes.txt < docs/project/SSOT.md",
      ["redirect:input"],
    ),
    blocked("redirect in a command substitution", "echo $(echo x > docs/project/SSOT.md)", [
      "segments",
    ]),
    blocked("redirect in backticks", "echo `echo x > docs/project/SSOT.md`", ["segments"]),
    allowed("stderr dup is not a file", "echo x 2>&1 > notes.txt"),
    allowed("redirect to a path built from a variable", "echo x > $HOME/x"),
    blocked("cd then a relative rm", "cd docs/project && rm SSOT.md", ["cd:moves"]),
    blocked("cd then a relative redirect", "cd docs/project; echo x > SSOT.md", ["cd:moves"]),
    blocked("pushd then a relative rm", "pushd docs/project && rm SSOT.md", ["cd:pushd"]),
    blocked("cd in a subshell then a relative cp", "(cd docs && cp ../a.txt project/SSOT.md)", [
      "cd:moves",
    ]),
    allowed("cd to an unprotected folder then rm of a same-named file", "cd src && rm SSOT.md", [
      "cd:control",
    ]),
    blocked(
      "a relative redirect with a cwd inside docs/project",
      "echo x > SSOT.md",
      ["cwd"],
      "docs-project",
    ),
    allowed("the same relative redirect with the root as cwd", "echo x > SSOT.md", ["cwd"], "root"),
    blocked(
      "a relative redirect above the cwd",
      "echo x > ../project/SSOT.md",
      ["cwd"],
      "docs-project",
    ),
    blocked("bash -c holding a write", "bash -c 'echo x > docs/project/SSOT.md'", ["shell-c"]),
    blocked("sh -c holding a write", 'sh -c "rm docs/project/SSOT.md"', ["shell-c"]),
    blocked("bash -lc holding a write", "bash -lc 'rm docs/project/SSOT.md'", ["shell-c"]),
    blocked("eval holding a write", "eval 'rm docs/project/SSOT.md'", ["shell-c", "shell:eval"]),
    allowed("bash -c holding a read", "bash -c 'cat docs/project/SSOT.md'", ["shell-c"]),
    blocked("sudo in front of a write", "sudo rm docs/project/SSOT.md", [
      "wrapper",
      "wrapper:sudo",
    ]),
    blocked("env with an assignment in front of a write", "env X=1 cp a.txt docs/project/SSOT.md", [
      "wrapper",
      "wrapper:env",
    ]),
    blocked("an assignment in front of a write", "X=1 rm docs/project/SSOT.md", [
      "wrapper",
      "wrapper:assignment",
    ]),
    blocked("rtk proxy in front of a write", "rtk proxy rm docs/project/SSOT.md", [
      "wrapper",
      "wrapper:rtk",
    ]),
    blocked("an absolute program path", "/bin/rm docs/project/SSOT.md", [
      "wrapper",
      "wrapper:absolute",
    ]),
    blocked("command in front of a write", "command rm docs/project/SSOT.md", [
      "wrapper",
      "wrapper:command",
    ]),
    blocked("an option before the operand of rm", "rm -f -- docs/project/SSOT.md", ["verb:rm"]),
    blocked("a dash-leading operand after --", "rm -- -r/../docs/project/SSOT.md", [
      "verb:rm",
      "options:double-dash",
    ]),
    blocked("cp with the target-directory option", "cp -t docs/project a.txt SSOT.md", [
      "verb:cp",
      "cp:target-directory",
      "nonrecursive-dest",
      "nonrecursive-dest:no-slash",
    ]),
    blocked("an unterminated quote is still scanned", "echo it's > docs/project/SSOT.md", [
      "fallback",
    ]),
    blocked("~ is expanded to the home folder", "echo x > ~/repo/docs/project/SSOT.md", ["tilde"]),
  ];
};

const patchSpecs = (): Spec[] => {
  const blockedPatch = (id: string, command: string, shown: string, tags: string[]): Spec => [
    id,
    {
      tags: ["patch", ...tags],
      input: bashCall(command),
      exit: 2,
      logged: blockedLog("Bash", shown),
    },
  ];
  const refusedPatch = (id: string, command: string, tags: string[]): Spec => [
    id,
    {
      tags: ["patch", "patch-unreadable", ...tags],
      input: bashCall(command),
      exit: 2,
      stderr: () => [REFUSAL_HEADING, "must name a readable patch file"],
    },
  ];
  const allowedPatch = (id: string, command: string, tags: string[]): Spec => [
    id,
    { tags: ["control", "patch", ...tags], input: bashCall(command) },
  ];
  return [
    blockedPatch(
      "patch -p1 -i with a header naming a protected file",
      "patch -p1 -i patches/protected.patch",
      "docs/project/SSOT.md",
      ["patch:headers"],
    ),
    blockedPatch(
      "patch with the patch file as the second operand",
      "patch notes.txt patches/protected.patch",
      "docs/project/SSOT.md",
      ["patch:headers"],
    ),
    blockedPatch(
      "patch --input= with a header naming a protected file",
      "patch --input=patches/protected.patch",
      "docs/project/SSOT.md",
      ["patch:headers"],
    ),
    blockedPatch(
      "patch with a protected file operand",
      "patch docs/project/SSOT.md patches/plain.patch",
      "docs/project/SSOT.md",
      ["patch:operand"],
    ),
    blockedPatch(
      "patch -i with a protected file operand",
      "patch -i patches/plain.patch docs/project/SSOT.md",
      "docs/project/SSOT.md",
      ["patch:operand"],
    ),
    blockedPatch(
      "patch -o to a protected file",
      "patch -o docs/project/SSOT.md notes.txt patches/plain.patch",
      "docs/project/SSOT.md",
      ["patch:output"],
    ),
    blockedPatch(
      "patch with a git header naming a protected file",
      "patch -p1 -i patches/gitdiff.patch",
      "docs/project/models.md",
      ["patch:headers", "apply:git-header"],
    ),
    blockedPatch(
      "patch with a header nested deep below the stripped prefix",
      "patch -p7 -i patches/deep.patch",
      "docs/project/SSOT.md",
      ["patch:headers", "patch:deep"],
    ),
    [
      "patch with a header naming .git",
      {
        tags: ["patch", "patch:headers", "patch:ab-prefix", "git"],
        input: bashCall("patch -p1 -i patches/git.patch"),
        exit: 2,
        logged: blockedLog("Bash", ".git/config"),
      },
    ],
    blockedPatch(
      "patch -d changes the base of the headers",
      "patch -d docs -p1 -i ../patches/relative.patch",
      "docs/project/SSOT.md",
      ["patch:headers", "patch:directory"],
    ),
    allowedPatch(
      "patch with a header naming an unprotected file",
      "patch -p1 -i patches/plain.patch",
      ["patch:headers"],
    ),
    allowedPatch("patch with unprotected operands", "patch notes.txt patches/plain.patch", [
      "patch:operand",
    ]),
    refusedPatch(
      "patch from a redirect names no patch file",
      "patch -p1 < patches/protected.patch",
      ["patch:stdin", "redirect:input"],
    ),
    refusedPatch(
      "patch from a heredoc names no patch file",
      "patch -p1 <<'EOF'\n--- a/notes.txt\nEOF",
      ["patch:stdin"],
    ),
    refusedPatch("patch with no patch file", "patch -p1", ["patch:stdin"]),
    refusedPatch("patch -i naming a missing file", "patch -i patches/missing.patch", [
      "patch:unreadable",
    ]),
    blockedPatch(
      "git apply with a header naming a protected file",
      "git apply patches/protected.patch",
      "docs/project/SSOT.md",
      ["apply:headers"],
    ),
    blockedPatch(
      "git apply with options before the patch",
      "git apply --check -p1 patches/gitdiff.patch",
      "docs/project/models.md",
      ["apply:headers", "apply:git-header"],
    ),
    blockedPatch(
      "git -C . apply",
      "git -C . apply patches/protected.patch",
      "docs/project/SSOT.md",
      ["apply:headers", "git:value-option"],
    ),
    blockedPatch(
      "git -C docs apply reads the patch and its headers from docs",
      "git -C docs apply ../patches/relative.patch",
      "docs/project/SSOT.md",
      ["apply:headers", "git:dash-c", "git:value-option"],
    ),
    blockedPatch(
      "git apply --directory",
      "git apply --directory=docs -p1 patches/relative.patch",
      "docs/project/SSOT.md",
      ["apply:headers", "apply:directory"],
    ),
    [
      "git apply with a header naming .git",
      {
        tags: ["patch", "apply:headers", "patch:ab-prefix", "git"],
        input: bashCall("git apply patches/git.patch"),
        exit: 2,
        logged: blockedLog("Bash", ".git/config"),
      },
    ],
    allowedPatch(
      "git apply with a header naming an unprotected file",
      "git apply patches/plain.patch",
      ["apply:headers"],
    ),
    refusedPatch("git apply with no patch file", "git apply", ["apply:stdin", "apply:stdin-none"]),
    refusedPatch("git apply reading standard input", "git apply -", [
      "apply:stdin",
      "apply:unreadable",
    ]),
    refusedPatch("git apply naming a missing file", "git apply --check patches/missing.patch", [
      "apply:unreadable",
    ]),
    refusedPatch("git apply from a heredoc", "git apply <<'EOF'\n--- a/notes.txt\nEOF", [
      "apply:stdin",
      "apply:stdin-none",
    ]),
  ];
};

const caseAndPathSpecs = (): Spec[] => {
  const blockedFile = (
    id: string,
    path: string,
    shown: string,
    tags: string[],
    tool = "Write",
    cwd?: string | ((c: RowContext) => string),
    root: RootKind = "main",
  ): Spec => [
    id,
    {
      root,
      tags: ["path", ...tags],
      input: (c) =>
        fileCall(tool, path.replaceAll("<root>", c.root), typeof cwd === "function" ? cwd(c) : cwd),
      exit: 2,
      logged: () => [`BLOCKED ${tool} ${shown}`],
    },
  ];
  return [
    blockedFile("a different letter case", "docs/Project/ssot.md", "docs/Project/ssot.md", [
      "fold",
      "entry:ssot",
    ]),
    blockedFile("all capitals", "DOCS/PROJECT/SSOT.MD", "DOCS/PROJECT/SSOT.MD", [
      "fold",
      "entry:ssot",
    ]),
    blockedFile(
      "a folder entry in another letter case",
      "docs/PRODUCT/Contracts/x.yaml",
      "docs/PRODUCT/Contracts/x.yaml",
      ["fold", "entry:product-contracts"],
    ),
    blockedFile(
      "the .claude folder in another letter case",
      "docs/.CLAUDE/hooks/x.sh",
      "docs/.CLAUDE/hooks/x.sh",
      ["fold", "entry:claude-folder"],
    ),
    blockedFile("a traversal spelling", "docs/project/../project/SSOT.md", "docs/project/SSOT.md", [
      "traversal",
      "entry:ssot",
    ]),
    blockedFile(
      "a traversal out of and back into a protected folder",
      "docs/product/../project/SSOT.md",
      "docs/project/SSOT.md",
      ["traversal", "entry:ssot"],
    ),
    blockedFile(
      "a traversal through a folder that does not exist",
      "docs/nothing/../project/SSOT.md",
      "docs/project/SSOT.md",
      ["traversal", "entry:ssot"],
    ),
    blockedFile(
      "a traversal through a symlink resolves the way the file system does",
      "docs/contracts/../../project/SSOT.md",
      "docs/project/SSOT.md",
      ["physical", "realpath", "entry:ssot"],
    ),
    blockedFile(
      "a traversal through a link that points outside normalises first",
      "linkout/../docs/project/SSOT.md",
      "docs/project/SSOT.md",
      ["normalise", "entry:ssot"],
    ),
    blockedFile(
      "a traversal through a link that points outside, into a link to a protected folder",
      "linkout/../src/proj/SSOT.md",
      "docs/project/SSOT.md",
      ["normalise", "realpath", "entry:ssot"],
    ),
    blockedFile("a leading ./", "./docs/project/SSOT.md", "docs/project/SSOT.md", ["entry:ssot"]),
    blockedFile("an absolute path", "<root>/docs/project/SSOT.md", "docs/project/SSOT.md", [
      "entry:ssot",
    ]),
    blockedFile("a doubled slash", "docs//project///SSOT.md", "docs/project/SSOT.md", [
      "entry:ssot",
    ]),
    blockedFile(
      "a new file below a protected folder",
      "docs/.claude/new/deep/file.md",
      "docs/.claude/new/deep/file.md",
      ["entry:claude-folder", "folder-match"],
    ),
    blockedFile(
      "a new file below the docs/contracts link",
      "docs/contracts/new/y.yaml",
      "docs/product/contracts/new/y.yaml",
      ["realpath", "entry:product-contracts", "folder-match"],
    ),
    blockedFile(
      "a file below a link to a protected folder",
      "src/proj/SSOT.md",
      "docs/project/SSOT.md",
      ["realpath", "entry:ssot"],
    ),
    blockedFile("a link to a protected file", "src/link-to-ssot", "docs/project/SSOT.md", [
      "realpath",
      "entry:ssot",
    ]),
    blockedFile(
      "a relative path with a cwd inside docs/project",
      "SSOT.md",
      "docs/project/SSOT.md",
      ["cwd", "entry:ssot"],
      "Write",
      (c) => join(c.root, "docs/project"),
    ),
    blockedFile(
      "a relative path above the cwd",
      "../project/SSOT.md",
      "docs/project/SSOT.md",
      ["cwd", "entry:ssot"],
      "Edit",
      (c) => join(c.root, "docs/product"),
    ),
    blockedFile(
      "a relative path with the root as cwd",
      "docs/project/SSOT.md",
      "docs/project/SSOT.md",
      ["cwd:same", "entry:ssot"],
      "Write",
      (c) => c.root,
    ),
    blockedFile(
      "a docs/contracts path in a root with no link",
      "docs/contracts/x.yaml",
      "docs/contracts/x.yaml",
      ["entry:contracts", "folder-match"],
      "Write",
      undefined,
      "bare",
    ),
    [
      "the path key instead of file_path",
      {
        tags: ["path", "path-key", "entry:ssot"],
        input: payload("Write", { path: "docs/project/SSOT.md" }),
        exit: 2,
        logged: blockedLog("Write", "docs/project/SSOT.md"),
      },
    ],
    [
      "a path below a protected FILE is not protected (exact match)",
      { tags: ["control", "exact-file"], input: fileCall("Write", "docs/project/SSOT.md/x.txt") },
    ],
    [
      "a relative path with the same name outside docs and the root as cwd",
      { tags: ["control", "cwd"], input: (c) => fileCall("Write", "SSOT.md", c.root) },
    ],
    [
      "a newline in a path is escaped in the log",
      {
        tags: ["log-shape", "entry:claude-folder"],
        input: fileCall("Write", "docs/.claude/x\nINJECT"),
        exit: 2,
        logged: () => ["BLOCKED Write docs/.claude/x\\x0aINJECT"],
      },
    ],
    [
      "a file written outside both repos is not protected",
      { tags: ["control"], input: fileCall("Write", "/tmp/lk-protect-table-outside.txt") },
    ],
  ];
};

const rootSpecs = (): Spec[] => [
  [
    "the project root is found from the script's own place when CLAUDE_PROJECT_DIR is unset",
    {
      tags: ["root:script", "entry:ssot"],
      root: "script",
      input: fileCall("Write", "docs/project/SSOT.md"),
      exit: 2,
      logged: blockedLog("Write", "docs/project/SSOT.md"),
    },
  ],
  [
    "an unprotected file under a root found from the script's place is allowed",
    { tags: ["control", "root:script"], root: "script", input: fileCall("Write", "notes.txt") },
  ],
];

const controllerSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  const roles: Role[] = ["controller", "unset", "reviewer"];
  const warned = (tags: string[]): Partial<RowSpec> => ({
    tags: ["controller", ...tags],
    stdout: "warning",
  });
  for (const role of roles) {
    specs.push([
      `${role}: Write SSOT.md warns and is allowed`,
      {
        ...warned(["old:ssot", `role:${role}`]),
        role,
        input: fileCall("Write", "docs/project/SSOT.md"),
      },
    ]);
    specs.push([
      `${role}: Write docs/contracts/ warns and is allowed`,
      {
        ...warned(["old:contracts", `role:${role}`]),
        role,
        input: fileCall("Write", "docs/contracts/x.yaml"),
      },
    ]);
    specs.push([
      `${role}: Edit state-machines.md warns and is allowed`,
      {
        ...warned(["old:state-machines", `role:${role}`]),
        role,
        input: fileCall("Edit", "docs/product/state-machines.md"),
      },
    ]);
    specs.push([
      `${role}: Write notes.txt is silent`,
      {
        tags: ["controller", "controller:unmatched", "same-as-implementer", `role:${role}`],
        role,
        input: fileCall("Write", "notes.txt"),
      },
    ]);
    specs.push([
      `${role}: a path key is read`,
      {
        ...warned(["old:ssot", "path-key", `role:${role}`]),
        role,
        input: payload("Write", { path: "docs/project/SSOT.md" }),
      },
    ]);
    specs.push([
      `${role}: a protected file the old script did not know is allowed silently`,
      {
        tags: ["controller", "controller:unmatched", `role:${role}`],
        role,
        input: fileCall("Write", "docs/CLAUDE.md"),
      },
    ]);
    specs.push([
      `${role}: a .git file is allowed silently`,
      {
        tags: ["controller", "controller:unmatched", `role:${role}`],
        role,
        input: fileCall("Write", ".git/config"),
      },
    ]);
    specs.push([
      `${role}: a redirect to SSOT.md is not examined`,
      {
        tags: ["controller", `role:${role}`, "role:bash"],
        role,
        input: bashCall("echo x > docs/project/SSOT.md"),
      },
    ]);
    specs.push([
      `${role}: input that is not JSON is allowed`,
      { tags: ["controller", "controller:empty-path", `role:${role}`], role, input: "not json" },
    ]);
    specs.push([
      `${role}: empty input is allowed`,
      { tags: ["controller", "controller:empty-path", `role:${role}`], role, input: "" },
    ]);
    specs.push([
      `${role}: a tool the hook does not know is allowed`,
      {
        tags: ["controller", "controller:unmatched", `role:${role}`],
        role,
        input: fileCall("Read", "notes.txt"),
      },
    ]);
    specs.push([
      `${role}: a grant changes nothing and no log is written`,
      {
        tags: ["controller", "old:ssot", `role:${role}`],
        role,
        grant: "docs/project/SSOT.md",
        input: fileCall("Write", "docs/project/SSOT.md"),
        stdout: "warning",
      },
    ]);
  }
  return specs;
};

const failClosedSpecs = (): Spec[] => {
  const refused = (id: string, input: string, message: string, tags: string[]): Spec => [
    id,
    { tags: ["fail-closed", ...tags], input, exit: 2, stderr: () => [REFUSAL_HEADING, message] },
  ];
  return [
    refused("input that is not JSON", "not json", "the hook input is not valid JSON", ["fc:json"]),
    refused("empty input", "", "the hook input is not valid JSON", ["fc:json"]),
    refused("JSON that is not an object", "[]", "the hook input is not a JSON object", [
      "fc:object",
    ]),
    refused(
      "a tool the hook does not know",
      fileCall("Read", "docs/project/SSOT.md"),
      "is not one this hook knows",
      ["fc:tool"],
    ),
    refused(
      "no tool name",
      JSON.stringify({ tool_input: { file_path: "x" } }),
      "is not one this hook knows",
      ["fc:tool"],
    ),
    refused(
      "a tool_input that is not an object",
      JSON.stringify({ tool_name: "Write", tool_input: "x" }),
      "holds no tool_input object",
      ["fc:tool-input"],
    ),
    refused("a file tool with no path", payload("Write", {}), "names no file path", ["fc:path"]),
    refused("a Bash call with no command text", payload("Bash", {}), "holds no command text", [
      "fc:command",
    ]),
    refused("a path holding a NUL byte", fileCall("Write", "docs/a\u0000b"), "the hook failed", [
      "fc:crash",
    ]),
    [
      "a missing python3 refuses",
      {
        tags: ["fail-closed", "fc:status"],
        input: fileCall("Write", "notes.txt"),
        extraEnv: { PATH: "<nopython>" },
        exit: 2,
        stderr: () => [],
      },
    ],
  ];
};

const grantSpecs = (): Spec[] => {
  const ssot = "docs/project/SSOT.md";
  const write = (tool = "Write", path = ssot): string => fileCall(tool, path);
  const allowed = (
    id: string,
    grant: string,
    path: string,
    shown: string,
    tags: string[],
    tool = "Write",
  ): Spec => [
    id,
    {
      tags: ["grant", ...tags],
      grant,
      input: fileCall(tool, path),
      logged: allowedLog(tool, shown),
    },
  ];
  const blocked = (
    id: string,
    grant: string | null,
    path: string,
    tags: string[],
    stderr: string[] = [],
  ): Spec => [
    id,
    {
      tags: ["grant", ...tags],
      grant,
      input: write("Write", path),
      exit: 2,
      logged: blockedLog("Write", path),
      stderr: (c) => [...blockMessage(path, c.slug), ...stderr],
    },
  ];
  const badEntry = (id: string, grant: string, reason: string, tags: string[]): Spec =>
    blocked(id, grant, ssot, ["grant-entry", ...tags, "entry:ssot"], [reason]);
  return [
    allowed("a grant for the exact file", ssot, ssot, ssot, ["grant:file"]),
    allowed("a grant for the exact file covers Edit", ssot, ssot, ssot, ["grant:file"], "Edit"),
    allowed(
      "a grant for the exact file covers MultiEdit",
      ssot,
      ssot,
      ssot,
      ["grant:file"],
      "MultiEdit",
    ),
    allowed("a grant for the folder prefix", "docs/project/", ssot, ssot, ["grant:folder"]),
    allowed(
      "a folder prefix covers another file below it",
      "docs/project/",
      "docs/project/models.md",
      "docs/project/models.md",
      ["grant:folder"],
    ),
    allowed(
      "a folder prefix covers a new file below it",
      "docs/.claude/",
      "docs/.claude/hooks/new/x.sh",
      "docs/.claude/hooks/new/x.sh",
      ["grant:folder"],
    ),
    allowed(
      "a grant for the real folder behind docs/contracts covers a file below it",
      "docs/product/contracts/",
      "docs/contracts/x.yaml",
      "docs/product/contracts/x.yaml",
      ["grant:folder", "grant:realpath", "realpath"],
    ),
    allowed(
      "a grant for the real file behind docs/contracts covers the file spelled through the link",
      "docs/product/contracts/x.yaml",
      "docs/contracts/x.yaml",
      "docs/product/contracts/x.yaml",
      ["grant:file", "grant:realpath", "realpath"],
    ),
    allowed(
      "the second entry of two covers its file",
      `${ssot}:docs/product/state-machines.md`,
      "docs/product/state-machines.md",
      "docs/product/state-machines.md",
      ["grant:file", "grant:list"],
    ),
    allowed("a grant in another letter case covers the file", "DOCS/PROJECT/SSOT.MD", ssot, ssot, [
      "grant:file",
      "fold",
    ]),
    blocked("a grant for another protected path", ssot, "docs/product/state-machines.md", [
      "grant:other",
    ]),
    blocked(
      "a file grant does not cover a sibling file",
      "docs/.claude/settings.json",
      "docs/.claude/hooks/x.sh",
      ["grant:other"],
    ),
    blocked(
      "a folder grant does not cover a folder beside it",
      "docs/project/",
      "docs/product/state-machines.md",
      ["grant:other"],
    ),
    blocked("an empty grant", "", ssot, ["grant:empty"]),
    blocked("no grant variable", null, ssot, ["grant:none"]),
    badEntry("a grant entry that is empty", ":" + ssot, "is empty", ["grant:empty-entry"]),
    badEntry("a trailing colon leaves an empty entry", ssot + ":", "is empty", [
      "grant:empty-entry",
      "grant:list",
    ]),
    badEntry("a grant entry of spaces", "  ", "is empty", ["grant:empty-entry"]),
    badEntry("an absolute grant entry", "/etc/hosts", "is absolute", ["grant:absolute"]),
    badEntry("a grant entry starting with a tilde", "~/x", "is absolute", [
      "grant:absolute",
      "grant:tilde",
    ]),
    badEntry("a grant entry holding ..", "docs/project/../project/SSOT.md", "holds ..", [
      "grant:dotdot",
    ]),
    badEntry("a grant entry climbing out", "../outside/x", "holds ..", ["grant:dotdot"]),
    badEntry("a grant entry with a star", "docs/project/*", "holds a wildcard", [
      "grant:wildcard",
      "wildcard:*",
    ]),
    badEntry("a grant entry with a question mark", "docs/project/SSOT.m?", "holds a wildcard", [
      "grant:wildcard",
      "wildcard:?",
    ]),
    badEntry("a grant entry with an opening bracket", "docs/project/[", "holds a wildcard", [
      "grant:wildcard",
      "wildcard:[",
    ]),
    badEntry("a grant entry with a closing bracket", "docs/project/]", "holds a wildcard", [
      "grant:wildcard",
      "wildcard:]",
    ]),
    badEntry("a grant for the product root", "./", "resolves to the product root", [
      "grant:root",
      "grant:trailing-slash",
    ]),
    badEntry("a grant for the product root as a dot", ".", "resolves to the product root", [
      "grant:root",
    ]),
    badEntry("a grant for the whole docs folder", "docs/", "resolves to the docs root", [
      "grant:docs-root",
      "grant:trailing-slash",
    ]),
    badEntry("a grant for the docs root with no slash", "docs", "resolves to the docs root", [
      "grant:docs-root",
    ]),
    badEntry("a grant for .git", ".git/", "resolves to a path under .git", ["grant:git"]),
    badEntry(
      "a grant for a file under docs/.git",
      "docs/.git/config",
      "resolves to a path under .git",
      ["grant:git"],
    ),
    badEntry(
      "a grant for a file under .git in another letter case",
      ".GIT/config",
      "resolves to a path under .git",
      ["grant:git", "fold"],
    ),
    [
      "a grant named without a trailing slash covers only that path",
      {
        tags: ["grant", "grant:file-not-prefix", "grant:folder-no-slash", "entry:ssot"],
        grant: "docs/project",
        input: fileCall("Write", ssot),
        exit: 2,
        logged: blockedLog("Write", ssot),
      },
    ],
    badEntry(
      "a good entry next to a bad one is ignored with it",
      `${ssot}:/etc/hosts`,
      "is absolute",
      ["grant:list", "grant:absolute"],
    ),
    [
      "a folder grant does not cover a path under .git",
      {
        tags: ["grant", "git", "grant:git-hit-folder"],
        grant: "docs/project/",
        input: fileCall("Write", ".git/config"),
        exit: 2,
        logged: blockedLog("Write", ".git/config"),
      },
    ],
    [
      "a file grant does not cover a path under .git",
      {
        tags: ["grant", "git", "grant:git-hit-file"],
        grant: ssot,
        input: fileCall("Write", ".git/config"),
        exit: 2,
        logged: blockedLog("Write", ".git/config"),
      },
    ],
    [
      "a folder grant does not cover a folder above the product root",
      {
        tags: ["grant", "grant:outside-hit", "ancestor", "ancestor:above-root"],
        grant: "docs/project/",
        input: (c) => bashCall("rm -rf ..", c.root),
        exit: 2,
        logged: () => ["BLOCKED Bash <base>"],
      },
    ],
    [
      "a file grant does not cover a path below it",
      {
        tags: ["grant", "grant:file-not-prefix"],
        grant: "docs/.claude/hooks/x.sh",
        input: fileCall("Write", "docs/.claude/hooks/x.sh/y"),
        exit: 2,
        logged: blockedLog("Write", "docs/.claude/hooks/x.sh/y"),
      },
    ],
    [
      "a grant that covers .git is refused and the write is blocked",
      {
        tags: ["grant", "grant-entry", "git", "grant:git"],
        grant: ".git/config",
        stderrNot: [],
        input: fileCall("Write", ".git/config"),
        exit: 2,
        logged: blockedLog("Write", ".git/config"),
        stderr: () => [...blockMessage(".git/config", "x"), "resolves to a path under .git"],
      },
    ],
    [
      "a folder grant for an ancestor covers a recursive remove of it",
      {
        tags: ["grant", "grant:exact-folder", "ancestor", "ancestor:entry", "ancestor:rm"],
        grant: "docs/project/",
        input: bashCall("rm -r docs/project"),
        logged: allowedLog("Bash", "docs/project"),
      },
    ],
    [
      "a file grant does not cover an ancestor",
      {
        tags: ["grant", "grant:other", "ancestor", "ancestor:entry", "ancestor:rm"],
        grant: ssot,
        input: bashCall("rm -r docs/project"),
        exit: 2,
        logged: blockedLog("Bash", "docs/project"),
        stderr: (c) => ancestorBlockMessage("docs/project", c.slug),
      },
    ],
    [
      "a grant for an existing log is appended to",
      {
        tags: ["grant", "grant:file", "log:append"],
        grant: ssot,
        input: fileCall("Write", ssot),
        prepare: (c) =>
          writeFileSync(
            join(c.root, ".work", c.slug, LOG_FILE),
            `${utcStamp()} ALLOWED Write ${ssot}\n`,
          ),
        logged: () => [`ALLOWED Write ${ssot}`, `ALLOWED Write ${ssot}`],
      },
    ],
    [
      "two spellings of one target are logged once",
      {
        tags: ["bash", "duplicate-hit", "entry:ssot"],
        input: bashCall("echo x | tee docs/project/SSOT.md docs/project/SSOT.md"),
        exit: 2,
        logged: blockedLog("Bash", ssot),
      },
    ],
    [
      "a Bash redirect covered by the exact file grant",
      {
        tags: ["grant", "grant:file", "verb:redirect"],
        grant: ssot,
        input: bashCall("echo x > docs/project/SSOT.md"),
        logged: allowedLog("Bash", ssot),
      },
    ],
    [
      "a Bash cp covered by the folder grant",
      {
        tags: ["grant", "grant:folder", "verb:cp"],
        grant: "docs/project/",
        input: bashCall("cp a.txt docs/project/SSOT.md"),
        logged: allowedLog("Bash", ssot),
      },
    ],
    [
      "a Bash patch covered by the exact file grant",
      {
        tags: ["grant", "grant:file", "patch:headers"],
        grant: ssot,
        input: bashCall("patch -p1 -i patches/protected.patch"),
        logged: allowedLog("Bash", ssot),
      },
    ],
    [
      "two protected targets with a grant for one are both blocked",
      {
        tags: ["grant", "grant:other", "grant:file", "multi"],
        grant: ssot,
        input: bashCall("cp a.txt docs/project/SSOT.md && cp a.txt docs/product/state-machines.md"),
        exit: 2,
        logged: () => [
          "BLOCKED Bash docs/project/SSOT.md",
          "BLOCKED Bash docs/product/state-machines.md",
        ],
        stderr: (c) => blockMessage("docs/product/state-machines.md", c.slug),
      },
    ],
    [
      "two protected targets with a grant for both are both allowed",
      {
        tags: ["grant", "grant:list", "grant:file", "multi"],
        grant: `${ssot}:docs/product/state-machines.md`,
        input: bashCall("cp a.txt docs/project/SSOT.md && cp a.txt docs/product/state-machines.md"),
        logged: () => [
          "ALLOWED Bash docs/project/SSOT.md",
          "ALLOWED Bash docs/product/state-machines.md",
        ],
      },
    ],
    [
      "a grant is not consulted for an unprotected path and nothing is logged",
      { tags: ["control", "grant"], grant: "/etc/hosts", input: fileCall("Write", "notes.txt") },
    ],
  ];
};

const logFailureSpecs = (): Spec[] => {
  const unlogged = (id: string, spec: Partial<RowSpec>): Spec => [
    id,
    {
      grant: "docs/project/SSOT.md",
      input: fileCall("Write", "docs/project/SSOT.md"),
      exit: 2,
      stderr: () => ["GOVERNANCE LOG UNAVAILABLE"],
      ...spec,
      tags: ["log-failure", "log:fail-refuses", "grant:file", ...(spec.tags ?? [])],
    },
  ];
  return [
    unlogged("no LK_SLUG with a grant refuses and creates nothing", {
      slug: null,
      after: (c) =>
        existsSync(join(c.root, ".work", LOG_FILE)) ? "a log appeared in .work" : undefined,
    }),
    unlogged("an empty LK_SLUG with a grant refuses and creates nothing", {
      slug: "",
      after: (c) =>
        existsSync(join(c.root, ".work", LOG_FILE)) ? "a log appeared in .work" : undefined,
    }),
    unlogged("a slug that is not a slug refuses", {
      slug: "..",
      slugFolder: false,
      after: (c) => (existsSync(join(c.root, LOG_FILE)) ? "a log appeared above .work" : undefined),
    }),
    unlogged("a slug with a slash refuses", { slug: "a/b", slugFolder: false }),
    unlogged("a slug that ends in something other than a slug refuses although its folder exists", {
      tags: ["log:slug-end"],
      slug: "abc.def",
    }),
    unlogged("a slug that does not match the slug pattern refuses although its folder exists", {
      tags: ["log:slug-pattern"],
      slug: "Bad.Slug",
    }),
    unlogged("a slug folder that does not exist refuses and is not created", {
      slug: "no-folder-here",
      slugFolder: false,
      after: (c) =>
        existsSync(join(c.root, ".work", "no-folder-here"))
          ? "the slug folder was created"
          : undefined,
    }),
    unlogged("a slug folder that is a link refuses", {
      tags: ["log:folder-link"],
      prepare: (c) => {
        rmSync(join(c.root, ".work", c.slug), { recursive: true });
        symlinkSync("../../outside", join(c.root, ".work", c.slug));
      },
      after: (c) =>
        existsSync(join(c.base, "outside", LOG_FILE))
          ? "a log appeared in the folder the link names"
          : undefined,
    }),
    unlogged(
      "a log file that is a link to a protected file refuses and writes nothing through it",
      {
        tags: ["log:nofollow"],
        prepare: (c) =>
          symlinkSync("../../docs/project/SSOT.md", join(c.root, ".work", c.slug, LOG_FILE)),
        after: (c) =>
          existsSync(join(c.root, "docs/project/SSOT.md"))
            ? "the protected file was created through the log link"
            : undefined,
      },
    ),
    [
      "no LK_SLUG without a grant is still blocked and the message is printed",
      {
        tags: ["log-failure", "log:blocked-append", "log:blocked-append:no-slug"],
        slug: null,
        input: fileCall("Write", "docs/project/SSOT.md"),
        exit: 2,
        stderr: () => blockMessage("docs/project/SSOT.md", "<slug>"),
        after: (c) =>
          existsSync(join(c.root, ".work", LOG_FILE)) ? "a log appeared in .work" : undefined,
      },
    ],
    [
      "a missing slug folder without a grant is still blocked",
      {
        tags: ["log-failure", "log:blocked-append"],
        slug: "no-folder-here",
        slugFolder: false,
        input: fileCall("Write", "docs/project/SSOT.md"),
        exit: 2,
        stderr: () => blockMessage("docs/project/SSOT.md", "no-folder-here"),
      },
    ],
  ];
};

// ---- the aliases of one disk --------------------------------------------------------------------

interface AliasSpelling {
  name: string;
  tags: string[];
  /** The root-relative path the call names, as typed. */
  path: string;
  spell: (root: string) => string;
}

const SSOT_PATH = "docs/project/SSOT.md";
const SSOT_OTHER_CASE = "docs/Project/ssot.md";

const ALIAS_SPELLINGS: AliasSpelling[] = [
  {
    name: "the /System/Volumes/Data prefix",
    tags: ["alias:data"],
    path: SSOT_PATH,
    spell: (root) => `${MAC_DATA_VOLUME}${root}`,
  },
  {
    name: "the /System/Volumes/Data prefix in another letter case",
    tags: ["alias:data", "alias:data-fold"],
    path: SSOT_PATH,
    spell: (root) => `/SYSTEM/volumes/Data${root}`,
  },
  {
    name: "the /System/Volumes/Data prefix and a path in another letter case",
    tags: ["alias:data", "alias:path-fold"],
    path: SSOT_OTHER_CASE,
    spell: (root) => `${MAC_DATA_VOLUME}${root}`,
  },
  {
    name: "a root with the leading /private added or taken off",
    tags: TEMP_ROOT_UNDER_PRIVATE ? ["alias:symlink"] : ["alias:private"],
    path: SSOT_PATH,
    spell: (root) => togglePrivate(root),
  },
  {
    name: "the /System/Volumes/Data prefix and a root with the leading /private added or taken off",
    tags: ["alias:data", "alias:private"],
    path: SSOT_PATH,
    spell: (root) => `${MAC_DATA_VOLUME}${togglePrivate(root)}`,
  },
  {
    name: "a /PRIVATE prefix in another letter case behind the /System/Volumes/Data prefix",
    tags: [
      "alias:data",
      "alias:private-fold",
      ...(TEMP_ROOT_UNDER_PRIVATE ? [] : ["alias:private"]),
    ],
    path: SSOT_PATH,
    spell: (root) => `${MAC_DATA_VOLUME}/PRIVATE${withoutPrivate(root)}`,
  },
];

const ALIAS_TOOLS = ["Edit", "Write", "MultiEdit", "Bash"] as const;

const aliasCall = (tool: string, spelled: string): string =>
  tool === "Bash" ? bashCall(`echo x > ${spelled}`) : fileCall(tool, spelled);

const aliasSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  for (const spelling of ALIAS_SPELLINGS) {
    for (const tool of ALIAS_TOOLS) {
      const input = (path: string) => (c: RowContext) =>
        aliasCall(tool, `${spelling.spell(c.root)}/${path}`);
      specs.push([
        `${tool} to the protected file through ${spelling.name}`,
        {
          tags: ["alias", ...spelling.tags, `tool:${tool}`],
          input: input(spelling.path),
          exit: 2,
          logged: blockedLog(tool, spelling.path),
        },
      ]);
      specs.push([
        `${tool} to an unprotected file through ${spelling.name} is allowed`,
        { tags: ["control", "alias", `tool:${tool}`], input: input("notes.txt") },
      ]);
    }
  }
  for (const [name, outside] of [
    ["a path under /private that is outside the root", "/private/tmp/lk-protect-table-outside.txt"],
    ["a path under /private/etc that is outside the root", "/private/etc/lk-protect-table-outside"],
    [
      "a path under /System/Volumes/Data that is outside the root",
      `${MAC_DATA_VOLUME}/tmp/lk-protect-table-outside.txt`,
    ],
  ]) {
    specs.push([
      `Write to ${name} is allowed`,
      { tags: ["control", "alias:outside"], input: fileCall("Write", outside as string) },
    ]);
    specs.push([
      `redirect to ${name} is allowed`,
      { tags: ["control", "alias:outside"], input: bashCall(`echo x > ${outside}`) },
    ]);
  }
  specs.push([
    "Write to a protected-looking path in a root beside the product root is allowed",
    {
      tags: ["control", "alias:outside"],
      input: (c) => fileCall("Write", `${MAC_DATA_VOLUME}${c.root}-beside/${SSOT_PATH}`),
    },
  ]);
  if (process.platform === "darwin") {
    specs.push(
      [
        "a product root spelled through /System/Volumes/Data still protects a relative path",
        {
          tags: ["alias", "alias:root-data:docs"],
          extraEnv: { CLAUDE_PROJECT_DIR: "<root:data>" },
          input: fileCall("Write", SSOT_PATH),
          exit: 2,
          logged: blockedLog("Write", SSOT_PATH),
        },
      ],
      [
        "a product root spelled through /System/Volumes/Data still protects .git",
        {
          tags: ["alias", "alias:root-data", "git"],
          extraEnv: { CLAUDE_PROJECT_DIR: "<root:data>" },
          input: fileCall("Write", ".git/config"),
          exit: 2,
          logged: blockedLog("Write", ".git/config"),
        },
      ],
      [
        "a product root spelled through /System/Volumes/Data honours a grant and logs it",
        {
          tags: ["alias", "alias:root-data:docs", "grant:file"],
          extraEnv: { CLAUDE_PROJECT_DIR: "<root:data>" },
          grant: SSOT_PATH,
          input: fileCall("Write", SSOT_PATH),
          logged: allowedLog("Write", SSOT_PATH),
        },
      ],
      [
        "a product root spelled without /private still protects a relative path",
        {
          tags: ["alias", "alias:root-symlink"],
          extraEnv: { CLAUDE_PROJECT_DIR: "<root:toggled>" },
          input: fileCall("Write", SSOT_PATH),
          exit: 2,
          logged: blockedLog("Write", SSOT_PATH),
        },
      ],
    );
  }
  return specs;
};

// ---- the /.vol alias of one file ----------------------------------------------------------------

const VOLUME_ALIAS_REFUSAL = "No governance grant can cover a path under /.vol";

interface VolumeSpelling {
  name: string;
  tags: string[];
  /** The text before the device and inode numbers, as typed. */
  prefix: string;
  /** What the hook shows for it: the alias with its dot segments and double slashes folded. */
  shown: string;
}

const volumeFile = (context: RowContext, protectedFile: boolean): string =>
  protectedFile
    ? join(context.root, "docs/.claude/hooks", `alias-${context.slug}.sh`)
    : join(context.root, `plain-${context.slug}.txt`);

// The mutation corpus reads a row's expectations before any fixture exists, so a missing file has no numbers yet.
const volumeNumbers = (context: RowContext, protectedFile: boolean): string => {
  const file = volumeFile(context, protectedFile);
  if (!existsSync(file)) return "0/0";
  const info = statSync(file, { bigint: true });
  return `${info.dev}/${info.ino}`;
};

const VOLUME_SPELLINGS: VolumeSpelling[] = [
  { name: "the /.vol alias", tags: ["vol:exact"], prefix: "/.vol", shown: "/.vol" },
  { name: "the /.VOL alias", tags: ["vol:fold"], prefix: "/.VOL", shown: "/.VOL" },
  { name: "the /.Vol alias", tags: ["vol:fold"], prefix: "/.Vol", shown: "/.Vol" },
  { name: "the //.vol alias", tags: ["vol:slashes"], prefix: "//.vol", shown: "/.vol" },
  { name: "the /./.vol alias", tags: ["vol:dots"], prefix: "/./.vol", shown: "/.vol" },
  { name: "the /x/../.vol alias", tags: ["vol:dots"], prefix: "/x/../.vol", shown: "/.vol" },
];

const VOLUME_BASH_FORMS: { form: string; command: (alias: string) => string }[] = [
  { form: "redirect", command: (alias) => `echo x > ${alias}` },
  { form: "cp", command: (alias) => `cp a.txt ${alias}` },
  { form: "tee", command: (alias) => `tee ${alias}` },
];

const volumeSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  const refusal = (
    id: string,
    spelling: VolumeSpelling,
    tool: string,
    toBeCalled: (alias: string) => string,
    protectedFile: boolean,
    tags: string[],
  ): Spec => {
    const aliasOf = (context: RowContext): string =>
      `${spelling.prefix}/${volumeNumbers(context, protectedFile)}`;
    const shownOf = (context: RowContext): string =>
      `${spelling.shown}/${volumeNumbers(context, protectedFile)}`;
    return [
      id,
      {
        tags: ["vol", ...spelling.tags, ...tags],
        prepare: (context) => writeFile(volumeFile(context, protectedFile), "x\n"),
        input: (context) => toBeCalled(aliasOf(context)),
        exit: 2,
        logged: (context) => [`BLOCKED ${tool} ${shownOf(context)}`],
        stderr: (context) => [`${BLOCK_HEADING}${shownOf(context)}`, VOLUME_ALIAS_REFUSAL],
      },
    ];
  };
  const fileTool = (tool: string) => (alias: string) => fileCall(tool, alias);
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    specs.push(
      refusal(
        `${tool} to a protected file through the /.vol alias of its numbers`,
        VOLUME_SPELLINGS[0] as VolumeSpelling,
        tool,
        fileTool(tool),
        true,
        ["vol:file-tool"],
      ),
    );
  }
  for (const { form, command } of VOLUME_BASH_FORMS) {
    specs.push(
      refusal(
        `${form} to a protected file through the /.vol alias of its numbers`,
        VOLUME_SPELLINGS[0] as VolumeSpelling,
        "Bash",
        (alias) => bashCall(command(alias)),
        true,
        ["vol:bash"],
      ),
    );
  }
  for (const spelling of VOLUME_SPELLINGS.slice(1)) {
    specs.push(
      refusal(
        `Write to a protected file through ${spelling.name} of its numbers`,
        spelling,
        "Write",
        fileTool("Write"),
        true,
        ["vol:file-tool"],
      ),
    );
    specs.push(
      refusal(
        `redirect to a protected file through ${spelling.name} of its numbers`,
        spelling,
        "Bash",
        (alias) => bashCall(`echo x > ${alias}`),
        true,
        ["vol:bash"],
      ),
    );
  }
  for (const tool of ["Write"]) {
    specs.push(
      refusal(
        `${tool} to an unprotected file through the /.vol alias of its numbers is refused`,
        VOLUME_SPELLINGS[0] as VolumeSpelling,
        tool,
        fileTool(tool),
        false,
        ["vol:file-tool", "vol:unprotected"],
      ),
    );
  }
  specs.push(
    refusal(
      "redirect to an unprotected file through the /.vol alias of its numbers is refused",
      VOLUME_SPELLINGS[0] as VolumeSpelling,
      "Bash",
      (alias) => bashCall(`echo x > ${alias}`),
      false,
      ["vol:bash", "vol:unprotected"],
    ),
  );
  specs.push(
    [
      "Write to a path that holds .vol in a later component is allowed",
      { tags: ["control", "vol"], input: fileCall("Write", "notes/.volume.txt") },
    ],
    [
      "redirect to a path that holds .vol in a later component is allowed",
      { tags: ["control", "vol"], input: bashCall("echo x > notes/.volume.txt") },
    ],
    [
      "Write to an absolute path with a .vol folder below the root is allowed",
      {
        tags: ["control", "vol"],
        input: (context) => fileCall("Write", `${context.root}/src/.vol/notes.txt`),
      },
    ],
  );
  return specs;
};

// ---- a module in the working folder --------------------------------------------------------------

const PLANTED_MODULE_BODY = "import os\nos._exit(0)\n";
const PLANTED_MODULES_OF_MAIN_PROGRAM = ["datetime", "json", "re", "shlex"];
const PLANTED_MODULES_OF_CONTROLLER_PROGRAM = ["json"];

const plantedFolder = (context: RowContext): string => join(context.base, `cwd-${context.slug}`);

const plantModule =
  (plantedModule: string | null) =>
  (context: RowContext): void => {
    mkdirSync(plantedFolder(context), { recursive: true });
    if (plantedModule === null) return;
    writeFileSync(join(plantedFolder(context), `${plantedModule}.py`), PLANTED_MODULE_BODY);
  };

const plantedModuleSpecs = (): Spec[] => {
  const specs: Spec[] = [];
  const planted = (plantedModule: string | null) => ({
    workingFolder: plantedFolder,
    prepare: plantModule(plantedModule),
  });
  const named = (plantedModule: string | null): string =>
    plantedModule === null ? "nothing planted" : `a ${plantedModule} module planted`;
  for (const plantedModule of [...PLANTED_MODULES_OF_MAIN_PROGRAM, null]) {
    const control = plantedModule === null;
    specs.push([
      `Write to a protected file with ${named(plantedModule)} in the working folder`,
      {
        ...planted(plantedModule),
        tags: [...(control ? ["control"] : ["planted", "planted:main"]), "planted:write"],
        input: fileCall("Write", SSOT_PATH),
        exit: 2,
        logged: blockedLog("Write", SSOT_PATH),
      },
    ]);
    specs.push([
      `redirect to a protected file with ${named(plantedModule)} in the working folder`,
      {
        ...planted(plantedModule),
        tags: [...(control ? ["control"] : ["planted", "planted:main"]), "planted:bash"],
        input: bashCall(`echo x > ${SSOT_PATH}`),
        exit: 2,
        logged: blockedLog("Bash", SSOT_PATH),
      },
    ]);
    if (control) continue;
    specs.push([
      `Write to an unprotected file with ${named(plantedModule)} in the working folder is allowed`,
      {
        ...planted(plantedModule),
        tags: ["control", "planted:twin"],
        input: fileCall("Write", "notes.txt"),
      },
    ]);
  }
  for (const plantedModule of [...PLANTED_MODULES_OF_CONTROLLER_PROGRAM, null]) {
    const control = plantedModule === null;
    for (const role of ["controller", "unset"] as const) {
      specs.push([
        `${role}: Write to a protected file warns with ${named(plantedModule)} in the working folder`,
        {
          ...planted(plantedModule),
          role,
          stdout: "warning",
          tags: [
            "controller",
            "old:ssot",
            `role:${role}`,
            ...(control ? [] : ["planted:controller"]),
          ],
          input: fileCall("Write", SSOT_PATH),
        },
      ]);
    }
    if (control) continue;
    specs.push([
      `controller: Write to an unprotected file with ${named(plantedModule)} in the working folder is silent`,
      {
        ...planted(plantedModule),
        role: "controller",
        tags: ["controller", "controller:unmatched", "same-as-implementer", "role:controller"],
        input: fileCall("Write", "notes.txt"),
      },
    ]);
  }
  return specs;
};

// ---- the caps ---------------------------------------------------------------------------------

const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const nestedBashC = (levels: number, inner: string): string =>
  Array.from({ length: levels }).reduce<string>(
    (command) => `bash -c ${shellQuote(command)}`,
    inner,
  );

const nestedEval = (levels: number, inner: string): string => `${"eval ".repeat(levels)}${inner}`;

const manyOperands = (count: number): string =>
  Array.from({ length: count }, (_value, index) => `f${index}`).join(" ");

const capSpecs = (): Spec[] => {
  const refused = (id: string, input: string, cap: string, tags: string[]): Spec => [
    id,
    {
      tags: ["cap", ...tags],
      input,
      exit: 2,
      stderr: () => [REFUSAL_HEADING, cap],
    },
  ];
  const allowed = (id: string, input: string, tags: string[]): Spec => [
    id,
    { tags: ["control", "cap", ...tags], input },
  ];
  const protectedCopy = "cp a.txt docs/project/SSOT.md";
  return [
    refused(
      "four nested evals around a write to a protected file are refused",
      bashCall(nestedEval(4, protectedCopy)),
      "levels deep",
      ["cap:depth"],
    ),
    refused(
      "four nested bash -c levels around a write to a protected file are refused",
      bashCall(nestedBashC(4, protectedCopy)),
      "levels deep",
      ["cap:depth"],
    ),
    allowed(
      "three nested evals around a write to an unprotected file are allowed",
      bashCall(nestedEval(3, "cp a.txt notes.txt")),
      ["cap:depth:inside"],
    ),
    allowed(
      "three nested bash -c levels around a write to an unprotected file are allowed",
      bashCall(nestedBashC(3, "cp a.txt notes.txt")),
      ["cap:depth:inside"],
    ),
    [
      "three nested evals around a write to a protected file are blocked",
      {
        tags: ["cap", "cap:depth:inside", "entry:ssot"],
        input: bashCall(nestedEval(3, protectedCopy)),
        exit: 2,
        logged: blockedLog("Bash", SSOT_PATH),
      },
    ],
    refused(
      `${TARGET_CAP + 1} targets before a protected one are refused`,
      bashCall(`truncate -s0 ${manyOperands(TARGET_CAP + 1)} docs/project/SSOT.md`),
      "write targets",
      ["cap:targets"],
    ),
    allowed(
      `${TARGET_CAP} unprotected targets are allowed`,
      bashCall(`truncate -s0 ${manyOperands(TARGET_CAP)}`),
      ["cap:targets:inside"],
    ),
    [
      `${TARGET_CAP - 1} targets before a protected one are blocked`,
      {
        tags: ["cap", "cap:targets:inside", "entry:ssot"],
        input: bashCall(`truncate -s0 ${manyOperands(TARGET_CAP - 1)} docs/project/SSOT.md`),
        exit: 2,
        logged: blockedLog("Bash", SSOT_PATH),
      },
    ],
    refused(
      "a patch file larger than the patch byte cap is refused",
      bashCall("patch -p1 -i patches/big.patch"),
      "is larger than",
      ["cap:patch", "patch", "patch:headers"],
    ),
    refused(
      "git apply of a patch file larger than the patch byte cap is refused",
      bashCall("git apply patches/big.patch"),
      "is larger than",
      ["cap:patch", "patch", "apply:headers"],
    ),
    allowed(
      "a patch file of exactly the patch byte cap with an unprotected header is allowed",
      bashCall("patch -p1 -i patches/edge.patch"),
      ["cap:patch:inside", "patch"],
    ),
    allowed(
      "git apply of a patch file of exactly the patch byte cap is allowed",
      bashCall("git apply patches/edge.patch"),
      ["cap:patch:inside", "patch"],
    ),
  ];
};

const deepPatchSpecs = (): Spec[] => [
  [
    "patch -p12 with a protected header behind 12 leading components is blocked",
    {
      tags: ["patch", "patch:headers", "patch:deep12", "entry:ssot"],
      input: bashCall("patch -p12 -i patches/deep12.patch"),
      exit: 2,
      logged: blockedLog("Bash", SSOT_PATH),
    },
  ],
  [
    "git apply -p12 with a protected header behind 12 leading components is blocked",
    {
      tags: ["patch", "apply:headers", "patch:deep12", "entry:ssot"],
      input: bashCall("git apply -p12 patches/deep12.patch"),
      exit: 2,
      logged: blockedLog("Bash", SSOT_PATH),
    },
  ],
  [
    "patch -p12 with an unprotected header behind 12 leading components is allowed",
    {
      tags: ["control", "patch", "patch:deep12"],
      input: bashCall("patch -p12 -i patches/deep12-plain.patch"),
    },
  ],
];

// ---- the spellings of a redirect and of a command -------------------------------------------------

const glueSpecs = (): Spec[] => {
  const glued: [name: string, command: (path: string) => string][] = [
    ["a redirect glued to ;", (path) => `echo hi;>${path}`],
    ["a redirect glued to &&", (path) => `true&&>${path}`],
    ["a redirect glued to a pipe", (path) => `echo a|>${path}`],
    ["a redirect glued to a closing parenthesis", (path) => `(echo x)>${path}`],
    ["a redirect glued to an opening parenthesis", (path) => `(>${path})`],
    ["an append redirect glued to ;", (path) => `echo hi;>>${path}`],
  ];
  const specs: Spec[] = [];
  for (const [name, command] of glued) {
    specs.push([
      name,
      {
        tags: ["bash", "entry:ssot", "verb:redirect", "redirect:glued"],
        input: bashCall(command(SSOT_PATH)),
        exit: 2,
        logged: blockedLog("Bash", SSOT_PATH),
      },
    ]);
    specs.push([
      `${name} to an unprotected file is allowed`,
      { tags: ["control", "redirect:glued"], input: bashCall(command("notes.txt")) },
    ]);
  }
  specs.push([
    "a redirect glued to ; after an unterminated quote is still scanned",
    {
      tags: ["bash", "entry:ssot", "verb:redirect", "redirect:glued-crude"],
      input: bashCall(`echo it's;>${SSOT_PATH}`),
      exit: 2,
      logged: blockedLog("Bash", SSOT_PATH),
    },
  ]);
  specs.push([
    "a redirect glued to ; after an unterminated quote to an unprotected file is allowed",
    { tags: ["control", "redirect:glued-crude"], input: bashCall("echo it's;>notes.txt") },
  ]);
  specs.push([
    "a read-write redirect opens a protected file for writing",
    {
      tags: ["bash", "entry:ssot", "redirect:readwrite"],
      input: bashCall(`exec 3<>${SSOT_PATH}`),
      exit: 2,
      logged: blockedLog("Bash", SSOT_PATH),
    },
  ]);
  specs.push([
    "a read-write redirect to an unprotected file is allowed",
    { tags: ["control", "redirect:readwrite"], input: bashCall("exec 3<>notes.txt") },
  ]);
  return specs;
};

const keywordSpecs = (): Spec[] => {
  const keyworded: [name: string, keywords: string[], command: (path: string) => string][] = [
    ["a brace group", ["{"], (path) => `{ tee ${path}; }`],
    ["a then branch", ["then"], (path) => `if true; then cp a.txt ${path}; fi`],
    ["a for loop body", ["do"], (path) => `for f in a.txt; do cp $f ${path}; done`],
    ["a negated command", ["!"], (path) => `! rm ${path}`],
    ["a while loop body", ["do"], (path) => `while false; do rm ${path}; done`],
    ["an until loop body", ["do"], (path) => `until true; do rm ${path}; done`],
    [
      "a then branch after an elif",
      ["then"],
      (path) => `if false; then true; elif true; then rm ${path}; fi`,
    ],
    ["an else branch", ["else"], (path) => `if false; then true; else rm ${path}; fi`],
    ["an if condition", ["if"], (path) => `if rm ${path}; then true; fi`],
    [
      "an elif condition",
      ["elif"],
      (path) => `if false; then true; elif rm ${path}; then true; fi`,
    ],
    ["a while condition", ["while"], (path) => `while rm ${path}; do true; done`],
    ["an until condition", ["until"], (path) => `until rm ${path}; do true; done`],
  ];
  const specs: Spec[] = [];
  for (const [name, keywords, command] of keyworded) {
    specs.push([
      `a write in ${name}`,
      {
        tags: ["bash", "entry:ssot", "keyword", ...keywords.map((keyword) => `keyword:${keyword}`)],
        input: bashCall(command(SSOT_PATH)),
        exit: 2,
        logged: blockedLog("Bash", SSOT_PATH),
      },
    ]);
    specs.push([
      `a write in ${name} to an unprotected file is allowed`,
      { tags: ["control", "keyword"], input: bashCall(command("notes.txt")) },
    ]);
  }
  return specs;
};

const descriptorSpecs = (): Spec[] => {
  const grant = "docs/.claude/hooks/x.sh";
  const insideClaude = (c: RowContext): string => join(c.root, "docs/.claude");
  const allowedHere = (name: string, command: string, tags: string[] = []): Spec => [
    `${name} in docs/.claude is allowed and writes no BLOCKED line`,
    {
      tags: ["control", "redirect:fd", ...tags],
      grant,
      input: (c) => bashCall(command, insideClaude(c)),
    },
  ];
  return [
    allowedHere("a stderr dup to stdout", "ls 2>&1", ["redirect:fd-digit"]),
    allowedHere("a stdout dup to stderr", "echo err >&2", ["redirect:fd-digit"]),
    allowedHere("a numbered stdout dup to stderr", "echo err 1>&2", ["redirect:fd-digit"]),
    allowedHere("a closed output descriptor", "echo x >&-", ["redirect:fd-dash"]),
    allowedHere("a closed numbered descriptor", "echo x 2>&-", ["redirect:fd-dash"]),
    allowedHere("an input dup", "cat <&0", ["redirect:fd-input"]),
    [
      "a redirect to a real protected file beside a descriptor dup is still blocked once",
      {
        tags: ["redirect:fd", "redirect:fd-digit", "verb:redirect", "cwd"],
        grant,
        input: (c) => bashCall("echo x 2>&1 > settings.json", insideClaude(c)),
        exit: 2,
        logged: blockedLog("Bash", "docs/.claude/settings.json"),
      },
    ],
  ];
};

const docsSpellingSpecs = (): Spec[] => [
  [
    "the script started through its docs/.claude spelling with no CLAUDE_PROJECT_DIR refuses",
    {
      tags: ["root:docs-spelling", "entry:ssot"],
      root: "script-docs",
      input: fileCall("Write", SSOT_PATH),
      exit: 2,
      stderr: () => [REFUSAL_HEADING, "CLAUDE_PROJECT_DIR is not set"],
    },
  ],
  [
    "the script started through its docs/.claude spelling is the controller's script for a controller",
    {
      tags: ["controller", "root:docs-spelling:controller"],
      root: "script-docs",
      role: "controller",
      input: fileCall("Write", SSOT_PATH),
      stdout: "warning",
    },
  ],
  [
    "the script started through its docs/.claude spelling is the controller's script for no role",
    {
      tags: ["controller", "root:docs-spelling:controller"],
      root: "script-docs",
      role: "unset",
      input: fileCall("Write", SSOT_PATH),
      stdout: "warning",
    },
  ],
];

// ---- the log, the grant and the command text, second pass ------------------------------------------

const PLANTED_JSON = '{"hooks":{}}\n';
const plantedPath = (context: RowContext, name: string): string =>
  join(context.root, "docs/.claude", name);
const logPathOf = (context: RowContext): string =>
  join(context.root, ".work", context.slug, LOG_FILE);

const makeFifo = (path: string): void => {
  if (spawnSync("mkfifo", [path]).status !== 0) throw new Error(`mkfifo ${path} failed`);
};

const FIFO_READERS = new Map<string, number>();

const holdFifoOpenForReading = (path: string, key: string): void => {
  FIFO_READERS.set(key, openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
};

/** Closes the reader and returns what was written to the pipe while it was open. */
const releaseFifoReader = (key: string): string => {
  const descriptor = FIFO_READERS.get(key);
  if (descriptor === undefined) return "";
  FIFO_READERS.delete(key);
  const buffer = Buffer.alloc(4096);
  let text = "";
  try {
    text = buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, null)).toString();
  } catch {
    text = "";
  }
  closeSync(descriptor);
  return text;
};

const logGuardSpecs = (): Spec[] => {
  const hardLinkToPlanted = (name: string) => (context: RowContext) => {
    writeFileSync(plantedPath(context, name), PLANTED_JSON);
    linkSync(plantedPath(context, name), logPathOf(context));
  };
  const plantedUnchanged = (name: string) => (context: RowContext) =>
    readFileSync(plantedPath(context, name), "utf8") === PLANTED_JSON
      ? undefined
      : `${name} was changed through the log`;
  const unavailable = (id: string, spec: Partial<RowSpec>): Spec => [
    id,
    {
      input: fileCall("Write", SSOT_PATH),
      grant: SSOT_PATH,
      exit: 2,
      ignoreLog: true,
      stderr: () => ["GOVERNANCE LOG UNAVAILABLE"],
      ...spec,
      tags: ["log-failure", ...(spec.grant === null ? [] : ["grant:file"]), ...(spec.tags ?? [])],
    },
  ];
  return [
    unavailable("a log that is a second name of a protected file refuses an allowed write", {
      tags: ["log:link-count"],
      stderr: () => ["GOVERNANCE LOG UNAVAILABLE", "more than one path"],
      prepare: hardLinkToPlanted("g1-allowed.json"),
      after: plantedUnchanged("g1-allowed.json"),
    }),
    unavailable(
      "a log that is a second name of a protected file is not written through when blocked",
      {
        tags: ["log:link-count"],
        grant: null,
        stderr: (c) => blockMessage(SSOT_PATH, c.slug),
        prepare: hardLinkToPlanted("g1-blocked.json"),
        after: plantedUnchanged("g1-blocked.json"),
      },
    ),
    unavailable("a log that is a pipe with no reader refuses an allowed write within seconds", {
      tags: ["log:non-blocking"],
      timeoutMs: 10_000,
      maxMs: 5_000,
      prepare: (c) => makeFifo(logPathOf(c)),
    }),
    unavailable("a log that is a pipe with no reader still blocks within seconds", {
      tags: ["log:non-blocking"],
      grant: null,
      timeoutMs: 10_000,
      maxMs: 5_000,
      stderr: (c) => blockMessage(SSOT_PATH, c.slug),
      prepare: (c) => makeFifo(logPathOf(c)),
    }),
    unavailable("a log that is a pipe with a reader is refused and nothing is written to it", {
      tags: ["log:regular"],
      stderr: () => ["GOVERNANCE LOG UNAVAILABLE", "not a regular file"],
      prepare: (c) => {
        makeFifo(logPathOf(c));
        holdFifoOpenForReading(logPathOf(c), c.slug);
      },
      after: (c) =>
        releaseFifoReader(c.slug) === "" ? undefined : "the script wrote a log line into the pipe",
    }),
    [
      "a log that is a regular file with one name is appended to",
      {
        tags: ["grant", "grant:file", "log:append", "log:link-control"],
        grant: SSOT_PATH,
        input: fileCall("Write", SSOT_PATH),
        prepare: (c) => writeFileSync(logPathOf(c), `${utcStamp()} ALLOWED Write ${SSOT_PATH}\n`),
        logged: () => [`ALLOWED Write ${SSOT_PATH}`, `ALLOWED Write ${SSOT_PATH}`],
      },
    ],
  ];
};

const grantLinkSpecs = (): Spec[] => {
  const hooks = "docs/.claude/hooks";
  const linkedFile = (name: string, target: string) => (context: RowContext) => {
    const path = join(context.root, hooks, name);
    writeFileSync(path, "x");
    rmSync(path);
    symlinkSync(target, path);
  };
  const linkedFolder = (name: string, target: string) => (context: RowContext) => {
    const path = join(context.root, hooks, name);
    mkdirSync(path);
    rmSync(path, { recursive: true });
    symlinkSync(target, path);
  };
  const refusedLinked = (
    id: string,
    grant: string,
    input: string,
    shown: string[],
    prepare: (context: RowContext) => void,
    tags: string[],
  ): Spec => [
    id,
    {
      tags: ["grant", "grant:link", "realpath", ...tags],
      grant,
      input,
      exit: 2,
      logged: () =>
        shown.map((path) => `BLOCKED ${input.includes('"Bash"') ? "Bash" : "Write"} ${path}`),
      stderr: () => [`${BLOCK_HEADING}${shown[0]}`, "symbolic link"],
      prepare,
    },
  ];
  return [
    [
      "a granted file replaced by a link to the SSOT file does not cover the SSOT file",
      {
        tags: ["grant", "grant:hook-resolves", "entry:ssot"],
        grant: `${hooks}/g2-ssot.sh`,
        input: fileCall("Write", SSOT_PATH),
        exit: 2,
        logged: blockedLog("Write", SSOT_PATH),
        prepare: linkedFile("g2-ssot.sh", "../../project/SSOT.md"),
      },
    ],
    refusedLinked(
      "a granted file replaced by a link to the SSOT file is refused when written",
      `${hooks}/g2-ssot-b.sh`,
      fileCall("Write", `${hooks}/g2-ssot-b.sh`),
      [`${hooks}/g2-ssot-b.sh`, SSOT_PATH],
      linkedFile("g2-ssot-b.sh", "../../project/SSOT.md"),
      ["entry:ssot"],
    ),
    refusedLinked(
      "a granted file replaced by a link to an unprotected file is refused when written",
      `${hooks}/g2-notes.sh`,
      fileCall("Write", `${hooks}/g2-notes.sh`),
      [`${hooks}/g2-notes.sh`],
      linkedFile("g2-notes.sh", "../../../notes.txt"),
      [],
    ),
    refusedLinked(
      "a Bash copy onto a granted file that is now a link is refused",
      `${hooks}/g2-notes-bash.sh`,
      bashCall(`cp a.txt ${hooks}/g2-notes-bash.sh`),
      [`${hooks}/g2-notes-bash.sh`],
      linkedFile("g2-notes-bash.sh", "../../../notes.txt"),
      ["verb:cp"],
    ),
    refusedLinked(
      "a granted folder replaced by a link to an unprotected folder is refused when written below",
      `${hooks}/g2-dir-src/`,
      fileCall("Write", `${hooks}/g2-dir-src/x.md`),
      [`${hooks}/g2-dir-src`],
      linkedFolder("g2-dir-src", "../../../src"),
      ["grant:link-folder"],
    ),
    refusedLinked(
      "a granted folder replaced by a link to docs/project is refused when the SSOT file is written below",
      `${hooks}/g2-dir-ssot/`,
      fileCall("Write", `${hooks}/g2-dir-ssot/SSOT.md`),
      [`${hooks}/g2-dir-ssot`, SSOT_PATH],
      linkedFolder("g2-dir-ssot", "../../project"),
      ["entry:ssot", "grant:link-folder"],
    ),
    [
      "a grant spelled with ./ components covers the path it names",
      {
        tags: ["grant", "grant:file", "grant:dot"],
        grant: "docs/./project/./SSOT.md",
        input: fileCall("Write", SSOT_PATH),
        logged: allowedLog("Write", SSOT_PATH),
      },
    ],
    [
      "a granted file that is still a file is allowed and logged",
      {
        tags: ["grant", "grant:file", "grant:link-control"],
        grant: `${hooks}/g2-intact.sh`,
        input: fileCall("Write", `${hooks}/g2-intact.sh`),
        logged: allowedLog("Write", `${hooks}/g2-intact.sh`),
        prepare: (c) => writeFileSync(join(c.root, hooks, "g2-intact.sh"), "x"),
      },
    ],
    [
      "a grant spelled through the docs/contracts link covers nothing, because the hook reads it as written",
      {
        tags: ["grant", "grant:hook-resolves", "entry:product-contracts"],
        grant: "docs/contracts/",
        input: fileCall("Write", "docs/product/contracts/x.yaml"),
        exit: 2,
        logged: blockedLog("Write", "docs/product/contracts/x.yaml"),
      },
    ],
    [
      "a file grant spelled through the docs/contracts link covers nothing, because the hook reads it as written",
      {
        tags: ["grant", "grant:hook-resolves", "entry:product-contracts"],
        grant: "docs/contracts/x.yaml",
        input: fileCall("Write", "docs/product/contracts/x.yaml"),
        exit: 2,
        logged: blockedLog("Write", "docs/product/contracts/x.yaml"),
      },
    ],
  ];
};

const commandTextSpecs = (): Spec[] => {
  const blocked = (id: string, command: string, tags: string[], shown = SSOT_PATH): Spec => [
    id,
    {
      tags: ["bash", "entry:ssot", ...tags],
      input: bashCall(command),
      exit: 2,
      logged: blockedLog("Bash", shown),
    },
  ];
  const allowed = (id: string, command: string, tags: string[]): Spec => [
    id,
    { tags: ["control", ...tags], input: bashCall(command) },
  ];
  const pairs = (name: string, command: (path: string) => string, tags: string[]): Spec[] => [
    blocked(`${name} to a protected file`, command(SSOT_PATH), tags),
    allowed(`${name} to an unprotected file is allowed`, command("notes.txt"), tags),
  ];
  const specs: Spec[] = [];
  // a # inside a word
  for (const [name, command] of [
    ["cp of a word with a hash", (path: string) => `cp a#b ${path}`],
    ["a redirect after a word with a hash", (path: string) => `echo a#b > ${path}`],
    ["a redirect after a hash and a semicolon", (path: string) => `echo a#b; echo y > ${path}`],
    ["a redirect after $#", (path: string) => `echo $#; echo y > ${path}`],
    ["a redirect after a length expansion", (path: string) => "echo ${#a}; echo y > " + path],
    [
      "a redirect after a format with a hash",
      (path: string) => `git log --format=%h#%s -1; echo y > ${path}`,
    ],
  ] as [string, (path: string) => string][]) {
    specs.push(...pairs(name, command, ["hash"]));
  }
  specs.push(
    allowed(
      "a comment after a space hides what follows it",
      "cp a.txt notes.txt # docs/project/SSOT.md",
      ["hash", "comment"],
    ),
  );
  // the program name in another letter case
  for (const [name, command, tag] of [
    ["CP", (path: string) => `CP a.txt ${path}`, "fold:verb"],
    ["Rm", (path: string) => `Rm ${path}`, "fold:verb"],
    ["TEE", (path: string) => `echo x | TEE ${path}`, "fold:verb"],
    ["SED -i", (path: string) => `SED -i s/a/b/ ${path}`, "fold:verb"],
    ["/BIN/CP", (path: string) => `/BIN/CP a.txt ${path}`, "fold:verb"],
    ["/bin/Cp", (path: string) => `/bin/Cp a.txt ${path}`, "fold:verb"],
    ["Mv", (path: string) => `Mv a.txt ${path}`, "fold:verb"],
    ["BASH -c", (path: string) => `BASH -c 'echo x > ${path}'`, "fold:verb"],
    [
      "GIT apply",
      (path: string) => `GIT apply patches/${path === SSOT_PATH ? "protected" : "plain"}.patch`,
      "fold:verb",
    ],
    ["Sudo", (path: string) => `Sudo cp a.txt ${path}`, "fold:wrapper"],
    ["ENV", (path: string) => `ENV cp a.txt ${path}`, "fold:wrapper"],
  ] as [string, (path: string) => string, string][]) {
    specs.push(...pairs(`${name} in capitals`, command, [tag, "fold"]));
  }
  // a patch whose header names an absolute path
  specs.push(
    blocked(
      "patch -p3 with an absolute header reaches the protected file",
      "patch -p3 -i patches/abs.patch",
      ["patch", "patch:headers", "patch:absolute"],
    ),
    blocked(
      "git apply -p3 with an absolute header reaches the protected file",
      "git apply -p3 patches/abs.patch",
      ["patch", "apply:headers", "patch:absolute"],
    ),
    allowed(
      "patch -p3 with an absolute header naming an unprotected file is allowed",
      "patch -p3 -i patches/abs-plain.patch",
      ["patch", "patch:absolute"],
    ),
    allowed(
      "git apply -p3 with an absolute header naming an unprotected file is allowed",
      "git apply -p3 patches/abs-plain.patch",
      ["patch", "patch:absolute"],
    ),
  );
  // process substitution
  for (const [name, command] of [
    ["a process substitution that copies", (path: string) => `cat <(cp a.txt ${path})`],
    ["an output process substitution that tees", (path: string) => `echo x > >(tee ${path})`],
    ["a process substitution that removes", (path: string) => `cat <(rm ${path})`],
    ["a process substitution that moves", (path: string) => `diff <(echo) <(mv a.txt ${path})`],
    [
      "a process substitution that edits in place",
      (path: string) => `cat <(sed -i s/a/b/ ${path})`,
    ],
    [
      "an output process substitution that runs dd",
      (path: string) => `echo x | cat > >(dd of=${path})`,
    ],
  ] as [string, (path: string) => string][]) {
    specs.push(
      blocked(name, command(SSOT_PATH), ["process-substitution"]),
      allowed(`${name} onto an unprotected file is allowed`, command("notes.txt"), [
        "process-substitution",
      ]),
    );
  }
  specs.push(
    allowed("two reading process substitutions are allowed", "diff <(cat a.txt) <(cat b.txt)", [
      "process-substitution",
    ]),
    allowed(
      "a reading process substitution and a redirect to an unprotected file",
      "cat <(echo hi) > notes.txt",
      ["process-substitution"],
    ),
    blocked(
      "a reading process substitution and a redirect to a protected file",
      "cat <(echo hi) > docs/project/SSOT.md",
      ["process-substitution", "process-substitution:redirect"],
    ),
  );
  // rsync with the source's relative path
  specs.push(
    blocked(
      "rsync -R names the protected file below the destination",
      "rsync -R project/SSOT.md docs/",
      ["rsync:relative", "verb:rsync"],
    ),
    blocked(
      "rsync --relative names the protected file below the destination",
      "rsync --relative project/SSOT.md docs/",
      ["rsync:relative", "verb:rsync"],
    ),
    blocked(
      "rsync -R names the path after /./ below the destination",
      "rsync -R src/./project/SSOT.md docs/",
      ["rsync:relative", "rsync:marker", "verb:rsync"],
    ),
    blocked(
      "rsync -R names an absolute source's path below the destination",
      "rsync -R /project/SSOT.md docs/",
      ["rsync:relative", "rsync:absolute", "verb:rsync"],
    ),
    allowed("rsync -R of an unprotected file into dist is allowed", "rsync -R a.txt dist/", [
      "rsync:relative",
    ]),
    allowed("rsync -R of an unprotected file into docs is allowed", "rsync -R a.txt docs/", [
      "rsync:relative",
    ]),
  );
  // where the later commands run after a cd
  const unionCases: [string, string, string][] = [
    ["a cd in a subshell", "(cd /tmp); echo x > docs/project/SSOT.md", "cd:subshell"],
    [
      "a cd and a command in a subshell",
      "(cd src && ls); echo x > docs/project/SSOT.md",
      "cd:subshell",
    ],
    [
      "a cd between two commands in a subshell",
      "(echo a; cd /tmp; echo b); echo x > docs/project/SSOT.md",
      "cd:nesting",
    ],
    ["a cd after ||", "true || cd /tmp; echo x > docs/project/SSOT.md", "cd:before"],
    ["a cd after &&", "false && cd /tmp; echo x > docs/project/SSOT.md", "cd:before"],
    ["a cd in a pipeline", "cd /tmp | echo x > docs/project/SSOT.md", "cd:after"],
    ["a cd in the background", "cd /tmp & echo x > docs/project/SSOT.md", "cd:after"],
    [
      "a cd in a conditional",
      "if false; then cd /tmp; fi; echo x > docs/project/SSOT.md",
      "cd:keyword",
    ],
    ["a cd in a brace group", "{ cd /tmp; }; echo x > docs/project/SSOT.md", "cd:keyword"],
    [
      "a cd after another command in a brace group",
      "{ echo a; cd /tmp; }; echo x > docs/project/SSOT.md",
      "cd:braces",
    ],
    ["a cd that fails", "cd /nonexistent; echo x > docs/project/SSOT.md", "cd:missing"],
    ["a cd with no operand", "cd; echo x > docs/project/SSOT.md", "cd:home"],
  ];
  for (const [name, command, reason] of unionCases) {
    specs.push(
      blocked(`${name} leaves the protected file named from the old place too`, command, [
        "cd:union",
        reason,
      ]),
    );
  }
  specs.push(
    blocked(
      "pushd and popd bring back the old place",
      "pushd /tmp; popd; echo x > docs/project/SSOT.md",
      ["cd:popd", "cd:popd-verb"],
    ),
    blocked("cd - brings back the old place", "cd /tmp; cd -; echo x > docs/project/SSOT.md", [
      "cd:popd",
      "cd:dash",
    ]),
    blocked(
      "cd - brings back every place the command has been",
      "cd docs/project; cd ..; cd -; echo x > SSOT.md",
      ["cd:history"],
    ),
    blocked("a plain cd moves the later command", "cd docs/project && echo x > SSOT.md", [
      "cd:moves",
    ]),
    allowed(
      "a plain cd into src and a write to an unprotected file is allowed",
      "cd src && echo x > notes.txt",
      ["cd:control"],
    ),
    allowed(
      "a plain cd moves the later command away from the protected path",
      "cd src && echo x > docs/project/SSOT.md",
      ["cd:moves"],
    ),
  );
  // the delimiter of a heredoc
  for (const delimiter of ['E"O"F', "EO'F'", 'E""OF']) {
    specs.push(
      blocked(
        `a heredoc delimiter spelled ${delimiter} ends at EOF and the next line writes`,
        `cat <<${delimiter}\nx\nEOF\necho y > docs/project/SSOT.md`,
        ["heredoc", "heredoc:quoted"],
      ),
    );
  }
  specs.push(
    blocked(
      "a heredoc delimiter spelled with a backslash ends at EOF and the next line writes",
      "cat <<\\EOF\nx\nEOF\necho y > docs/project/SSOT.md",
      ["heredoc", "heredoc:backslash"],
    ),
    allowed(
      "a heredoc delimiter with a quote inside the word keeps the text of the body unread",
      'cat <<E"O"F\necho x > docs/project/SSOT.md\nEOF',
      ["heredoc", "heredoc:quoted", "heredoc:body"],
    ),
    [
      "a heredoc with no closing line is refused",
      {
        tags: ["fail-closed", "heredoc", "heredoc:unterminated"],
        input: bashCall("cat <<EOF\nx\necho y > docs/project/SSOT.md"),
        exit: 2,
        stderr: () => [REFUSAL_HEADING, "no closing line"],
      },
    ],
  );
  return specs;
};

const allSpecs = (): Spec[] => [
  ...matrixSpecs(),
  ...readOnlySpecs(),
  ...allowedControlSpecs(),
  ...logFileSpecs(),
  ...gitProgramSpecs(),
  ...ancestorSpecs(),
  ...gitFolderSpecs(),
  ...bashFormSpecs(),
  ...patchSpecs(),
  ...caseAndPathSpecs(),
  ...rootSpecs(),
  ...controllerSpecs(),
  ...failClosedSpecs(),
  ...grantSpecs(),
  ...logFailureSpecs(),
  ...aliasSpecs(),
  ...volumeSpecs(),
  ...plantedModuleSpecs(),
  ...glueSpecs(),
  ...keywordSpecs(),
  ...descriptorSpecs(),
  ...capSpecs(),
  ...deepPatchSpecs(),
  ...docsSpellingSpecs(),
  ...logGuardSpecs(),
  ...grantLinkSpecs(),
  ...commandTextSpecs(),
];

export const PROTECT_TABLE: readonly ProtectRow[] = allSpecs().map(([id, spec], index) =>
  buildRow(id, index, spec),
);

/** The table with extra rows after the ones above, for rows that live outside this repository. */
export const tableWithRows = (extraSpecs: readonly Spec[]): readonly ProtectRow[] => [
  ...PROTECT_TABLE,
  ...extraSpecs.map(([id, spec], index) => buildRow(id, PROTECT_TABLE.length + index, spec)),
];

/** What a corpus file may use from this module; it is handed over at load time, never imported. */
export interface ProofKit {
  tempRootUnderPrivate: boolean;
  bashCall: (command: string, cwd?: string) => string;
  fileCall: (tool: string, path: string, cwd?: string) => string;
}

export const PROOF_KIT: ProofKit = {
  tempRootUnderPrivate: TEMP_ROOT_UNDER_PRIVATE,
  bashCall,
  fileCall,
};

// ---- the throwaway root ----------------------------------------------------------------------

export interface TableFixture {
  base: string;
  main: string;
  bare: string;
  script: string;
  noPython: string;
}

const writeFile = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const PATCH_BODY = (name: string): string => `--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+x\n`;

const ABSOLUTE_PATCH_BODY = (name: string): string =>
  `--- ${name}\n+++ ${name}\n@@ -0,0 +1 @@\n+x\n`;

const LEADING_COMPONENTS_12 = "1/2/3/4/5/6/7/8/9/10/11/12";

/** A patch of exactly `size` bytes: the head, lines of filler, then the tail. */
const paddedPatch = (head: string, tail: string, size: number): string => {
  const fillerSize = size - head.length - tail.length;
  const fullLines = Math.floor(fillerSize / 1000);
  const rest = fillerSize - fullLines * 1000;
  const lastLine = rest === 0 ? "" : `${"x".repeat(rest - 1)}\n`;
  return `${head}${`${"x".repeat(999)}\n`.repeat(fullLines)}${lastLine}${tail}`;
};

const buildProject = (root: string, withLinks: boolean, withDocsProject = true): void => {
  for (const folder of [
    ...(withDocsProject ? ["docs/project"] : []),
    "docs/product",
    "docs/.claude/hooks",
    "docs/.git",
    ".git",
    "nested/.git",
    ".work",
    "src",
    ".github/workflows",
    "patches",
  ]) {
    mkdirSync(join(root, folder), { recursive: true });
  }
  writeFile(join(root, "notes.txt"), "notes\n");
  writeFile(join(root, "a.txt"), "a\n");
  writeFile(join(root, "src/a.txt"), "a\n");
  if (!withLinks) return;
  mkdirSync(join(root, "docs/product/contracts"), { recursive: true });
  symlinkSync("product/contracts", join(root, "docs/contracts"));
  symlinkSync("docs/CLAUDE.md", join(root, "CLAUDE.md"));
  symlinkSync("docs/AGENTS.md", join(root, "AGENTS.md"));
  symlinkSync("docs/.claude", join(root, ".claude"));
  symlinkSync("../outside", join(root, "linkout"));
  symlinkSync("../docs/project/SSOT.md", join(root, "src/link-to-ssot"));
  symlinkSync("../docs/project", join(root, "src/proj"));
  writeFile(join(root, "patches/protected.patch"), PATCH_BODY("docs/project/SSOT.md"));
  writeFile(join(root, "patches/plain.patch"), PATCH_BODY("notes.txt"));
  writeFile(join(root, "patches/abs.patch"), ABSOLUTE_PATCH_BODY("/tmp/zz/docs/project/SSOT.md"));
  writeFile(join(root, "patches/abs-plain.patch"), ABSOLUTE_PATCH_BODY("/tmp/zz/notes.txt"));
  writeFile(join(root, "patches/git.patch"), PATCH_BODY(".git/config"));
  writeFile(join(root, "patches/relative.patch"), PATCH_BODY("project/SSOT.md"));
  writeFile(join(root, "patches/deep.patch"), PATCH_BODY("1/2/3/4/5/docs/project/SSOT.md"));
  writeFile(
    join(root, "patches/deep12.patch"),
    PATCH_BODY(`${LEADING_COMPONENTS_12}/docs/project/SSOT.md`),
  );
  writeFile(
    join(root, "patches/deep12-plain.patch"),
    PATCH_BODY(`${LEADING_COMPONENTS_12}/notes.txt`),
  );
  writeFile(
    join(root, "patches/edge.patch"),
    paddedPatch(PATCH_BODY("notes.txt"), "", PATCH_BYTE_CAP),
  );
  writeFile(
    join(root, "patches/big.patch"),
    paddedPatch(
      PATCH_BODY("notes.txt"),
      PATCH_BODY("docs/project/SSOT.md"),
      PATCH_BYTE_CAP + PATCH_BODY("docs/project/SSOT.md").length,
    ),
  );
  writeFile(
    join(root, "patches/gitdiff.patch"),
    "diff --git a/docs/project/models.md b/docs/project/models.md\nindex 1..2 100644\n",
  );
};

export const buildTableFixture = (): TableFixture => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lk-protect-table-")));
  const main = join(base, "repo");
  const bare = join(base, "bare");
  const script = join(base, "scripted");
  mkdirSync(join(base, "outside"));
  mkdirSync(join(base, "other/.git"), { recursive: true });
  buildProject(main, true);
  buildProject(bare, false, false);
  buildProject(script, false);
  mkdirSync(join(script, ".claude/hooks"), { recursive: true });
  const noPython = join(base, "no-python-bin");
  mkdirSync(noPython);
  for (const program of ["cat"]) symlinkSync(`/bin/${program}`, join(noPython, program));
  return { base, main, bare, script, noPython };
};

// ---- running a row -----------------------------------------------------------------------------

export interface ProtectMismatch {
  id: string;
  reasons: string[];
  stderr: string;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group has already ended
  }
};

const runHook = (
  hookPath: string,
  input: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<HookRun> =>
  new Promise((resolveRun) => {
    const child = spawn("/bin/bash", [hookPath], {
      env: env as NodeJS.ProcessEnv,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    // The python program is a child of the wrapper and holds the output pipes, so a hung run is
    // ended by killing the whole group.
    const timer = setTimeout(() => killGroup(child.pid), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

const rowEnvironment = (
  row: ProtectRow,
  fixture: TableFixture,
  root: string,
  slug: string | null,
): Record<string, string> => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: fixture.base,
    TZ: ZONE_FAR_FROM_UTC,
  };
  if (row.role !== "unset") env.LK_ROLE = row.role;
  if (slug !== null) env.LK_SLUG = slug;
  if (row.grant !== null) env.LK_GOVERNANCE_GRANT = row.grant;
  if (row.root !== "script" && row.root !== "script-docs") env.CLAUDE_PROJECT_DIR = root;
  for (const [name, value] of Object.entries(row.extraEnv)) {
    env[name] = envValueOf(value, fixture, root);
  }
  return env;
};

const envValueOf = (value: string, fixture: TableFixture, root: string): string =>
  value === "<nopython>"
    ? fixture.noPython
    : value
        .replaceAll("<root:data>", `${MAC_DATA_VOLUME}${root}`)
        .replaceAll("<root:toggled>", togglePrivate(root));

const rootOf = (row: ProtectRow, fixture: TableFixture): string => {
  if (row.root === "bare") return fixture.bare;
  if (row.root === "script" || row.root === "script-docs") return fixture.script;
  return fixture.main;
};

const readLog = (path: string): string[] | undefined =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : undefined;

const logProblems = (row: ProtectRow, context: RowContext, logPath: string): string[] => {
  if (row.ignoreLog) return [];
  const expected = row.logged(context);
  const lines = readLog(logPath);
  if (expected.length === 0) return lines === undefined ? [] : ["log"];
  if (lines === undefined) return ["log"];
  const shapes = lines.map((line) => LOG_LINE.exec(line));
  if (shapes.some((shape) => shape === null)) return ["log-shape"];
  const bare = lines.map((line) => line.split(" ").slice(1).join(" "));
  if (JSON.stringify(bare) !== JSON.stringify(expected)) return ["log"];
  const stamps = lines.map((line) => Date.parse(line.split(" ")[0] ?? ""));
  return stamps.some((stamp) => Math.abs(Date.now() - stamp) > MAX_LOG_CLOCK_SKEW_MS)
    ? ["log-time"]
    : [];
};

const stderrProblems = (row: ProtectRow, context: RowContext, run: HookRun): string[] => {
  const wanted = row.stderr(context);
  if (row.exit === 0) return run.stderr === "" ? [] : ["stderr"];
  if (row.stderrNot.some((text) => run.stderr.includes(text))) return ["stderr"];
  return wanted.every((text) => run.stderr.includes(text)) && run.stderr !== "" ? [] : ["stderr"];
};

const stdoutProblems = (row: ProtectRow, run: HookRun): string[] => {
  if (row.stdout === "warning") return run.stdout.includes(CONTROLLER_WARNING) ? [] : ["stdout"];
  return run.stdout === "" ? [] : ["stdout"];
};

const runRow = async (
  row: ProtectRow,
  fixture: TableFixture,
  hookPath: string,
): Promise<ProtectMismatch | undefined> => {
  const root = rootOf(row, fixture);
  const slug = row.slug;
  const context: RowContext = { base: fixture.base, root, slug: slug ?? "" };
  const workFolder = join(root, ".work", slug ?? "none");
  if (slug !== null && slug !== "" && row.slugFolder) mkdirSync(workFolder, { recursive: true });
  row.prepare?.(context);
  const logPath = join(workFolder, LOG_FILE);
  const env = rowEnvironment(row, fixture, root, slug);
  const startedAt = Date.now();
  const run = await runHook(
    hookPath,
    row.input(context),
    env,
    row.workingFolder(context),
    row.timeoutMs,
  );
  const tookMs = Date.now() - startedAt;
  const reasons = [
    ...(run.status === row.exit ? [] : ["exit"]),
    ...(row.maxMs !== null && tookMs > row.maxMs ? ["time"] : []),
    ...stdoutProblems(row, run),
    ...stderrProblems(row, context, run),
    ...logProblems(row, context, logPath),
    ...(row.after?.(context) === undefined ? [] : ["after"]),
  ];
  return reasons.length === 0 ? undefined : { id: row.id, reasons, stderr: run.stderr };
};

const runPool = async <Item, Result>(
  items: readonly Item[],
  size: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const results: Result[] = new Array<Result>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as Item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
};

/** Runs the rows (the whole table by default) through the script and returns those it answered differently, in order. */
export const protectTableMismatches = async (
  hookPath: string,
  rows: readonly ProtectRow[] = PROTECT_TABLE,
  concurrency: number = ROW_CONCURRENCY,
): Promise<ProtectMismatch[]> => {
  const fixture = buildTableFixture();
  try {
    const hookInRoot = join(fixture.script, ".claude/hooks", SCRIPT_NAME);
    const hookInDocs = join(fixture.script, "docs/.claude/hooks", SCRIPT_NAME);
    for (const copy of [hookInRoot, hookInDocs]) {
      copyFileSync(hookPath, copy);
      chmodSync(copy, 0o755);
    }
    const hookForRow = (row: ProtectRow): string => {
      if (row.root === "script") return hookInRoot;
      return row.root === "script-docs" ? hookInDocs : hookPath;
    };
    const found = await runPool(rows, concurrency, (row) => runRow(row, fixture, hookForRow(row)));
    return found.filter((mismatch): mismatch is ProtectMismatch => mismatch !== undefined);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
};
