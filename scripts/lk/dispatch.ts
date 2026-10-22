/**
 * Starts one implementer session for a work item, headless, on the model the model table names.
 *
 * Run: node --import tsx scripts/lk/dispatch.ts init <slug>
 *      node --import tsx scripts/lk/dispatch.ts run <slug> --job <job> --tier <1|2|3>
 *        [--model <id>] [--no-smoke] [--dry-run]
 *      node --import tsx scripts/lk/dispatch.ts status <slug>
 * Every command also takes `--root <dir>` for the repository root, default the working directory.
 *
 * A work item is the folder `.work/<slug>/`. `run` refuses, never repairs: a wrong role, a prompt
 * that may have been cut off, a model the table cannot resolve, a session already running or a
 * model that does not answer within SMOKE_TIMEOUT_SECONDS each stop it before anything is written.
 * Every refusal is one line starting `LK REFUSED: ` and exits 1. One session runs at a time,
 * enforced by `.work/.lock`.
 *
 * LK_GOVERNANCE_GRANT, in every session and smoke call, is the entries of the one
 * `governance-grant:` line of `.work/<slug>/01-spec.md`, each resolved once, here, to its real path
 * relative to the product root (a folder entry keeps its trailing slash), joined by colons, or the
 * empty string, so a value in the dispatcher's own environment never reaches a session. The hook
 * never resolves an entry again. More than one such line, or an entry the protect-file hook would
 * refuse, stops `run` like any other refusal.
 *
 * A session killed by a signal is recorded as failed with exit 128 plus the signal number and the
 * signal's name. A real run that removes a stale lock marks the dead holder's run record, if it
 * still says running, as failed and lost.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isRequestedTier,
  LkRefusal,
  MODEL_ID_PATTERN,
  parseCliArgs,
  readModels,
  refuse,
  resolveJob,
  stringOption,
  type Env,
  type ModelClass,
} from "./models";

// Matching is on the command text. A git global option (-C, -c, --no-pager, --git-dir=) sits
// between `git` and the subcommand, so each git rule has a twin with a wildcard there. The
// wildcard also matches a commit message that holds the rule's words, and that over-block is
// accepted. A branch whose name contains "main" is blocked by the push rule on purpose: the text is
// not parsed. The permission matcher knows `*` and nothing else: no character class, no `?`, and a
// pattern that ends in `:*` is read as the old prefix syntax, which matches `npm run db` but never
// `npm run db:reset`. So the db rules end in `db*` and the refspec rule spells the colon as `:**`.
const plainGitForms = (rest: string): string[] => [`Bash(git ${rest})`, `Bash(git * ${rest})`];

// The rtk PreToolUse hook rewrites push and branch commands before the deny rules are checked, so
// the session sees `rtk git ...` and the plain patterns never match the rewritten text.
const rtkGitForms = (rest: string): string[] => [
  ...plainGitForms(rest),
  `Bash(rtk git ${rest})`,
  `Bash(rtk git * ${rest})`,
];

// A trailing ` *` matches the bare command only when it is the pattern's one wildcard. Every form
// with an earlier `*` (the global option, a flag value) also names the ending with nothing after it.
export const gitFormsEndingIn = (rest: string): string[] => [
  `Bash(git ${rest})`,
  `Bash(git ${rest} *)`,
  `Bash(git * ${rest})`,
  `Bash(git * ${rest} *)`,
];

const RM_LEADING_LETTERS = ["d", "f", "i", "I", "P", "v", "W", "x"];
const RM_RECURSIVE_LETTERS = ["r", "R"];

// A cluster of up to three of the macOS rm flag letters (d f i I P R r v W x) that holds an r or R
// starts with zero, one or two non-recursive letters and then its first r or R; the `rm -r*` and
// `rm -R*` entries take the clusters that start with r or R. The same clusters are matched as a
// later argument. A cluster with three or more letters before its first r or R is not named.
export const rmClusterPatterns = (): string[] => {
  const pairs = RM_LEADING_LETTERS.flatMap((first) =>
    RM_LEADING_LETTERS.map((second) => `${first}${second}`),
  );
  const leads = [...RM_LEADING_LETTERS, ...pairs];
  const clusters = leads.flatMap((lead) =>
    RM_RECURSIVE_LETTERS.map((recursive) => `${lead}${recursive}`),
  );
  return clusters.flatMap((cluster) => [`Bash(rm -${cluster}*)`, `Bash(rm * -${cluster}*)`]);
};

const PUSH_NON_FORCE_LETTERS = ["u", "v", "n", "q"];
const PUSH_FORCE_OR_DELETE_LETTERS = ["f", "d"];

// A cluster of push short flags (u v n q f d) that holds an f or d but does not start with one
// starts with one or two of u v n q and then its first f or d; `push -f*` and `push -d*` take the
// clusters that start with f or d. The same clusters are matched as a later argument, in the plain,
// global option and rtk forms. A cluster with three or more letters before its first f or d is not
// named.
export const pushClusterPatterns = (): string[] => {
  const pairs = PUSH_NON_FORCE_LETTERS.flatMap((first) =>
    PUSH_NON_FORCE_LETTERS.map((second) => `${first}${second}`),
  );
  const leads = [...PUSH_NON_FORCE_LETTERS, ...pairs];
  const clusters = leads.flatMap((lead) =>
    PUSH_FORCE_OR_DELETE_LETTERS.map((letter) => `${lead}${letter}`),
  );
  return clusters.flatMap((cluster) => [
    ...rtkGitForms(`push -${cluster}*`),
    ...rtkGitForms(`push * -${cluster}*`),
  ]);
};

// The git restore flags that leave the whole-tree discard in force when they stand just before the
// dot. `--staged` is left out on purpose: `git restore --staged .` only unstages.
const RESTORE_FLAGS_BEFORE_DOT = [
  "-q",
  "--quiet",
  "-m",
  "--merge",
  "--ours",
  "--theirs",
  "--ignore-unmerged",
  "--progress",
  "--no-progress",
  "--overlay",
  "--no-overlay",
  "--recurse-submodules",
  "--no-recurse-submodules",
];
const WHOLE_TREE_SPELLINGS = [".", "./"];

// Every restore ending that discards the whole tree: the bare dot, a restore flag or a revision
// before it, `--worktree` or a W in a flag cluster anywhere before it, and the `--source` forms.
export const restoreDiscardPatterns = (): string[] =>
  WHOLE_TREE_SPELLINGS.flatMap((dot) => [
    ...gitFormsEndingIn(`restore ${dot}`),
    ...gitFormsEndingIn(`restore -- ${dot}`),
    ...gitFormsEndingIn(`restore *--worktree* ${dot}`),
    ...gitFormsEndingIn(`restore *W* ${dot}`),
    ...gitFormsEndingIn(`restore --source* ${dot}`),
    ...gitFormsEndingIn(`restore -s * ${dot}`),
    ...RESTORE_FLAGS_BEFORE_DOT.flatMap((flag) => gitFormsEndingIn(`restore *${flag} ${dot}`)),
  ]);

export const DENY_PATTERNS: readonly string[] = [
  ...plainGitForms("reset --hard*"),
  ...plainGitForms("reset * --hard*"),
  ...plainGitForms("clean*"),
  "Bash(rm -r*)",
  "Bash(sudo *)",
  "Bash(gh *)",
  "Bash(vercel *)",
  "Bash(railway *)",
  "Bash(npm run db:*)",
  // A force flag, a `+` refspec or a flag cluster that holds f or d anywhere after the remote.
  ...rtkGitForms("push --force*"),
  ...rtkGitForms("push -f*"),
  ...rtkGitForms("push * --force*"),
  ...rtkGitForms("push * -f*"),
  ...rtkGitForms("push * +*"),
  ...pushClusterPatterns(),
  // A push to main, and the pushes that name no branch and so go wherever HEAD points.
  ...rtkGitForms("push *main*"),
  ...rtkGitForms("push"),
  ...rtkGitForms("push origin"),
  // HEAD as an argument, the flags that push or delete refs in bulk, a refspec with a colon (which
  // deletes when its source is empty) and the upstream flag with no branch after it.
  ...rtkGitForms("push *HEAD*"),
  ...rtkGitForms("push *--all*"),
  ...rtkGitForms("push *--mirror*"),
  ...rtkGitForms("push *--delete*"),
  ...rtkGitForms("push -d*"),
  ...rtkGitForms("push * -d*"),
  ...rtkGitForms("push *:**"),
  ...rtkGitForms("push -u"),
  ...rtkGitForms("push -u origin"),
  // Any git reached by an absolute path steps around every git rule here, so none is allowed.
  "Bash(/*/git *)",
  // Recursive removal in every flag spelling, and rm reached by an absolute path.
  "Bash(rm -R*)",
  "Bash(rm --recursive*)",
  "Bash(rm * -r*)",
  "Bash(rm * -R*)",
  "Bash(rm * --recursive*)",
  ...rmClusterPatterns(),
  "Bash(/*/rm *)",
  // Deleting or resetting a branch outright, in either flag order.
  ...rtkGitForms("branch -D*"),
  ...rtkGitForms("branch -f*"),
  ...rtkGitForms("branch * -f*"),
  ...rtkGitForms("branch --force*"),
  ...rtkGitForms("branch * --force*"),
  ...rtkGitForms("branch -df*"),
  ...rtkGitForms("branch * -D*"),
  // Throwing away every uncommitted change in the tree. A path argument that only starts with a
  // dot, such as .gitignore or .github/x, is not the whole tree and stays allowed.
  ...WHOLE_TREE_SPELLINGS.flatMap((dot) => [
    ...gitFormsEndingIn(`checkout ${dot}`),
    ...gitFormsEndingIn(`checkout * ${dot}`),
  ]),
  ...plainGitForms("checkout -f*"),
  ...plainGitForms("checkout * -f*"),
  ...plainGitForms("checkout --force*"),
  // Forcing a switch discards uncommitted changes, and -B or -C resets a branch to where HEAD is.
  ...plainGitForms("switch -f*"),
  ...plainGitForms("switch * -f*"),
  ...plainGitForms("switch --discard-changes*"),
  ...plainGitForms("switch * --discard-changes*"),
  ...plainGitForms("checkout -B*"),
  ...plainGitForms("checkout * -B*"),
  ...plainGitForms("switch -C*"),
  ...plainGitForms("switch * -C*"),
  ...restoreDiscardPatterns(),
  // The ntfy topic is a secret; the pattern covers ~, $HOME and absolute spellings of the path.
  "Read(~/.config/lombakita/**)",
  "Edit(~/.config/lombakita/**)",
  "Write(~/.config/lombakita/**)",
  "Bash(cat *.config/lombakita/*)",
  "Bash(head *.config/lombakita/*)",
  "Bash(tail *.config/lombakita/*)",
  "Bash(less *.config/lombakita/*)",
  "Bash(grep *.config/lombakita/*)",
  // The rtk hook also rewrites these commands: `rtk gh ...`, `rtk npm run ...`, `rtk read` for cat
  // and head, and `rtk grep`.
  "Bash(rtk gh *)",
  "Bash(npm run db*)",
  "Bash(rtk npm run db*)",
  "Bash(rtk read *.config/lombakita/*)",
  "Bash(rtk grep *.config/lombakita/*)",
];

export const DENY_LIST = DENY_PATTERNS.join(",");

export const SLUG_PATTERN = /^[a-z]+(-[a-z]+)*$/;
export const END_MARKER = "END OF PROMPT";

const WORK_DIR = ".work";
const LOCK_FILE = ".lock";
const PROMPT_FILE = "02-prompt.md";
const SPEC_FILE = "01-spec.md";
const GRANT_LINE_PREFIX = "governance-grant:";
const GRANT_WILDCARDS = /[*?[\]]/;
const RUN_FILE = "run.json";
const SESSION_LOG_FILE = "session.jsonl";
const MODELS_FILE_IN_ROOT = "docs/project/models.md";
const SMOKE_PROMPT = "reply with the single word ok";
export const SMOKE_TIMEOUT_SECONDS = 60;

export const buildClaudeArgs = (promptText: string, model: string): string[] => [
  "-p",
  promptText,
  "--model",
  model,
  "--permission-mode",
  "bypassPermissions",
  "--disallowedTools",
  DENY_LIST,
  "--output-format",
  "stream-json",
  "--verbose",
];

export const buildSmokeArgs = (model: string): string[] => [
  "-p",
  SMOKE_PROMPT,
  "--model",
  model,
  "--max-turns",
  "1",
  "--output-format",
  "text",
];

export interface RunRecord {
  slug: string;
  job: string;
  tier: string;
  class: ModelClass;
  model: string;
  override: boolean;
  status: "running" | "done" | "failed";
  started: string;
  pid: number;
  exit?: number;
  signal?: string;
  lost?: boolean;
  ended?: string;
}

export interface ProcessOptions {
  cwd: string;
  env: Env;
}

/** A session killed by a signal carries 128 plus the signal number as its exit code. */
export interface SessionEnd {
  exitCode: number;
  signal?: string;
}

/**
 * `onSpawn` receives the session's own pid as soon as the process exists. If it throws, the session
 * is killed and the promise rejects with that error once the session is gone.
 */
export type SpawnSession = (
  args: string[],
  options: ProcessOptions & { logPath: string; onSpawn: (childPid: number) => void },
) => Promise<SessionEnd>;

export type RunSmoke = (
  model: string,
  options: ProcessOptions,
) => { status: number | null; stdout: string; timedOut: boolean };

export interface DispatchDeps {
  spawnSession: SpawnSession;
  runSmoke: RunSmoke;
  isProcessAlive: (pid: number) => boolean;
  pid: number;
  print: (line: string) => void;
}

export interface RunOptions {
  slug: string;
  job: string;
  tier: string;
  model: string | undefined;
  noSmoke: boolean;
  dryRun: boolean;
}

const workPath = (root: string, ...parts: string[]): string => join(root, WORK_DIR, ...parts);

const requireValidSlug = (slug: string | undefined): string => {
  if (slug === undefined || !SLUG_PATTERN.test(slug)) {
    refuse(`slug "${slug ?? ""}" does not match ${SLUG_PATTERN.source}`);
  }
  return slug;
};

const requireControllerRole = (env: Env): void => {
  if (env.LK_ROLE !== "controller") refuse('LK_ROLE must be "controller" to dispatch');
};

const readPromptText = (root: string, slug: string): string => {
  const folder = workPath(root, slug);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) refuse(`no work folder ${folder}`);
  const promptPath = join(folder, PROMPT_FILE);
  const text = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  if (text.trim() === "") refuse(`${promptPath} is missing or empty`);
  const lastLine = text.split("\n").findLast((line) => line.trim() !== "");
  if (lastLine !== END_MARKER) refuse(`${promptPath} does not end with the line ${END_MARKER}`);
  return text;
};

// The real path of the longest prefix of the path that exists, with the rest appended.
const realPathOfLongestPrefix = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPathOfLongestPrefix(parent), basename(path));
  }
};

const isUnder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}${sep}`);

type GrantEntryResolution = { problem: string } | { resolved: string };

/** The part of a real path below a folder, as it is spelled on disk, with a slash after a folder entry. */
const belowFolder = (path: string, folder: string): string => path.slice(folder.length + 1);

const resolveGrantEntry = (root: string, entry: string): GrantEntryResolution => {
  if (entry.includes(":")) return { problem: "holds a colon" };
  if (entry.startsWith("/")) return { problem: "starts with a slash" };
  if (entry.startsWith("~")) return { problem: "starts with a tilde" };
  if (entry.includes("..")) return { problem: "holds .." };
  if (GRANT_WILDCARDS.test(entry)) return { problem: "holds a wildcard character" };
  const realRoot = realPathOfLongestPrefix(root);
  const realDocs = realPathOfLongestPrefix(join(root, "docs"));
  const resolved = realPathOfLongestPrefix(resolve(root, entry));
  const folded = resolved.toLowerCase();
  const foldedRoot = realRoot.toLowerCase();
  const foldedDocs = realDocs.toLowerCase();
  if (folded === foldedRoot) return { problem: "resolves to the product root" };
  if (folded === foldedDocs) return { problem: "resolves to the docs root" };
  if (folded.split(sep).includes(".git")) return { problem: "resolves to a path under .git" };
  const underRoot = isUnder(folded, foldedRoot);
  if (!underRoot && !isUnder(folded, foldedDocs)) {
    return { problem: "resolves outside the product root" };
  }
  if (!entry.endsWith("/") && existsSync(resolved) && statSync(resolved).isDirectory()) {
    return { problem: "names a folder without a trailing slash" };
  }
  const relative = underRoot
    ? belowFolder(resolved, realRoot)
    : join("docs", belowFolder(resolved, realDocs));
  return { resolved: entry.endsWith("/") ? `${relative}/` : relative };
};

/** The entries of the one `governance-grant:` line of the work item's spec as real paths, or none. */
export const readGovernanceGrant = (root: string, slug: string): string[] => {
  const specPath = workPath(root, slug, SPEC_FILE);
  if (!existsSync(specPath)) return [];
  const grantLines = readFileSync(specPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(GRANT_LINE_PREFIX));
  if (grantLines.length > 1) {
    refuse(`${specPath} holds ${grantLines.length} ${GRANT_LINE_PREFIX} lines, not 1`);
  }
  const entries = (grantLines[0] ?? "")
    .slice(GRANT_LINE_PREFIX.length)
    .split(/\s+/)
    .filter(Boolean);
  return entries.map((entry) => {
    const resolution = resolveGrantEntry(root, entry);
    if ("problem" in resolution) refuse(`governance grant entry "${entry}" ${resolution.problem}`);
    return resolution.resolved;
  });
};

const resolveSession = (
  root: string,
  job: string,
  tier: string,
  modelOverride: string | undefined,
): { class: ModelClass; model: string; override: boolean } => {
  if (!isRequestedTier(tier)) refuse(`tier must be 1, 2 or 3, not "${tier}"`);
  const resolved = resolveJob(readModels(join(root, MODELS_FILE_IN_ROOT)), job, tier);
  if (modelOverride === undefined) return { ...resolved, override: false };
  if (!MODEL_ID_PATTERN.test(modelOverride)) {
    refuse(`--model "${modelOverride}" is not a model id (${MODEL_ID_PATTERN.source})`);
  }
  return { class: resolved.class, model: modelOverride, override: true };
};

/** `pid` is the dispatcher; `childPid` is the session it started, once there is one. */
interface LockHolder {
  pid: number;
  slug: string;
  childPid?: number;
}

const readLock = (lockPath: string): LockHolder => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const { pid, slug, childPid } = parsed as Record<string, unknown>;
    const childPidIsValid = childPid === undefined || typeof childPid === "number";
    if (typeof pid === "number" && typeof slug === "string" && childPidIsValid) {
      return { pid, slug, childPid };
    }
  } catch {
    // Falls through to the refusal below: a lock this file cannot read cannot be called stale.
  }
  return refuse(`${lockPath} is unreadable, remove it by hand once no session is running`);
};

const LOCK_TEMP_SUFFIX = ".tmp";

const readRunRecord = (runPath: string): RunRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as RunRecord) : undefined;
  } catch {
    return undefined;
  }
};

/** Returns whether the record was rewritten; only a record that still says running is touched. */
const markRunLost = (root: string, slug: string): boolean => {
  if (!SLUG_PATTERN.test(slug)) return false;
  const record = readRunRecord(workPath(root, slug, RUN_FILE));
  if (record === undefined || record.slug !== slug || record.status !== "running") return false;
  writeRunRecord(root, {
    ...record,
    status: "failed",
    lost: true,
    ended: new Date().toISOString(),
  });
  return true;
};

const refuseIfLockHeld = (root: string, deps: DispatchDeps, removeStale: boolean): void => {
  const lockPath = workPath(root, LOCK_FILE);
  if (!existsSync(lockPath)) return;
  const holder = readLock(lockPath);
  const livePid = [holder.pid, holder.childPid].find(
    (pid) => pid !== undefined && deps.isProcessAlive(pid),
  );
  if (livePid !== undefined) {
    refuse(`slug ${holder.slug} holds the lock (pid ${livePid})`);
  }
  if (!removeStale) {
    deps.print("LK NOTE: stale lock present, a real run removes it");
    return;
  }
  const markedLost = markRunLost(root, holder.slug);
  rmSync(lockPath, { force: true });
  deps.print("LK NOTE: stale lock removed");
  if (markedLost) deps.print(`LK NOTE: run ${holder.slug} was left running and is marked lost`);
};

/** Writes the content to a temporary file next to the lock, hands the path to `publish`, then removes it. */
const publishLockContent = (
  root: string,
  holder: LockHolder,
  publish: (temporaryPath: string) => void,
): void => {
  const temporaryPath = workPath(root, `${LOCK_FILE}.${holder.pid}${LOCK_TEMP_SUFFIX}`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(holder));
    publish(temporaryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

// Linking a finished file creates the lock or fails, and a reader never sees a part-written one.
const writeLock = (root: string, holder: LockHolder): void => {
  const lockPath = workPath(root, LOCK_FILE);
  try {
    publishLockContent(root, holder, (temporaryPath) => linkSync(temporaryPath, lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    refuse(`slug ${readLock(lockPath).slug} holds the lock`);
  }
};

const recordChildInLock = (root: string, holder: LockHolder, childPid: number): void => {
  const lockPath = workPath(root, LOCK_FILE);
  publishLockContent(root, { ...holder, childPid }, (temporaryPath) =>
    renameSync(temporaryPath, lockPath),
  );
};

const writeRunRecord = (root: string, record: RunRecord): void => {
  writeFileSync(workPath(root, record.slug, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`);
};

const sessionEnv = (env: Env, slug: string, grant: readonly string[]): Env => ({
  ...env,
  LK_ROLE: "implementer",
  LK_SLUG: slug,
  LK_GOVERNANCE_GRANT: grant.join(":"),
});

const refuseUnlessModelAnswers = (
  model: string,
  options: ProcessOptions,
  runSmoke: RunSmoke,
): void => {
  const { status, stdout, timedOut } = runSmoke(model, options);
  if (timedOut) refuse(`model ${model} did not answer within ${SMOKE_TIMEOUT_SECONDS} seconds`);
  if (status !== 0 || !/\bok\b/i.test(stdout)) refuse(`model ${model} did not answer`);
};

const printDryRun = (
  options: RunOptions,
  session: { class: ModelClass; model: string; override: boolean },
  promptText: string,
  print: (line: string) => void,
): void => {
  const args = buildClaudeArgs(`<${promptText.length} characters>`, session.model);
  print(
    `LK DRY-RUN ${options.slug} job=${options.job} tier=${options.tier} class=${session.class} model=${session.model} override=${session.override}`,
  );
  print(`args: ${JSON.stringify(args)}`);
};

const runSession = async (
  root: string,
  record: RunRecord,
  promptText: string,
  childEnv: Env,
  deps: DispatchDeps,
): Promise<number> => {
  const holder: LockHolder = { pid: deps.pid, slug: record.slug };
  writeLock(root, holder);
  let end: SessionEnd = { exitCode: 1 };
  try {
    writeRunRecord(root, record);
    end = await deps.spawnSession(buildClaudeArgs(promptText, record.model), {
      cwd: root,
      env: childEnv,
      logPath: workPath(root, record.slug, SESSION_LOG_FILE),
      onSpawn: (childPid) => recordChildInLock(root, holder, childPid),
    });
  } finally {
    try {
      const status = end.exitCode === 0 ? "done" : "failed";
      writeRunRecord(root, {
        ...record,
        status,
        exit: end.exitCode,
        ...(end.signal === undefined ? {} : { signal: end.signal }),
        ended: new Date().toISOString(),
      });
    } finally {
      rmSync(workPath(root, LOCK_FILE), { force: true });
    }
  }
  return end.exitCode;
};

/** Returns the exit code the dispatcher itself should exit with. */
export const dispatchRun = async (
  options: RunOptions,
  root: string,
  env: Env,
  deps: DispatchDeps,
): Promise<number> => {
  requireControllerRole(env);
  const slug = requireValidSlug(options.slug);
  const promptText = readPromptText(root, slug);
  const childEnv = sessionEnv(env, slug, readGovernanceGrant(root, slug));
  const session = resolveSession(root, options.job, options.tier, options.model);
  refuseIfLockHeld(root, deps, !options.dryRun);
  if (options.dryRun) {
    printDryRun(options, session, promptText, deps.print);
    return 0;
  }
  if (!options.noSmoke) {
    refuseUnlessModelAnswers(session.model, { cwd: root, env: childEnv }, deps.runSmoke);
  }
  const record: RunRecord = {
    slug,
    job: options.job,
    tier: options.tier,
    ...session,
    status: "running",
    started: new Date().toISOString(),
    pid: deps.pid,
  };
  const exitCode = await runSession(root, record, promptText, childEnv, deps);
  deps.print(`LK DISPATCH ${slug} ${exitCode === 0 ? "done" : "failed"} exit ${exitCode}`);
  return exitCode;
};

export const initWorkItem = (root: string, slug: string | undefined): string => {
  const validSlug = requireValidSlug(slug);
  const folder = workPath(root, validSlug);
  mkdirSync(workPath(root), { recursive: true });
  if (existsSync(folder)) refuse(`${folder} already exists`);
  mkdirSync(folder);
  return folder;
};

export const readRunStatus = (root: string, slug: string | undefined): string => {
  const runPath = workPath(root, requireValidSlug(slug), RUN_FILE);
  return existsSync(runPath) ? readFileSync(runPath, "utf8").trimEnd() : "no run";
};

// The project's type declarations make NODE_ENV a required key of ProcessEnv; a child process
// only needs the strings, so the looser Env is handed over as is.
const toChildEnv = (env: Env): NodeJS.ProcessEnv => env as NodeJS.ProcessEnv;

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const createRunSmoke =
  (timeoutSeconds: number): RunSmoke =>
  (model, { cwd, env }) => {
    const result = spawnSync("claude", buildSmokeArgs(model), {
      cwd,
      env: toChildEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutSeconds * 1000,
      killSignal: "SIGKILL",
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return { status: result.status, stdout: result.stdout ?? "", timedOut };
  };

export const runSmokeWithClaude = createRunSmoke(SMOKE_TIMEOUT_SECONDS);

const SPAWN_FAILED_EXIT = 127;
const SIGNAL_EXIT_BASE = 128;

// A terminated dispatcher must not leave a running session behind a lock that looks free, so these
// signals go to the session and the dispatcher keeps waiting until it ends.
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const sessionEndOf = (code: number | null, signal: NodeJS.Signals | null): SessionEnd => {
  if (signal === null) return { exitCode: code ?? 1 };
  return { exitCode: SIGNAL_EXIT_BASE + osConstants.signals[signal], signal };
};

// The handlers go in before the session is started, in the same synchronous run as the spawn, so a
// signal that arrives once the session exists reaches it and none can run the default action,
// which ends the dispatcher and leaves the session behind a lock that looks free.
export const spawnSessionWithClaude: SpawnSession = (args, { cwd, env, logPath, onSpawn }) =>
  new Promise((resolveEnd, rejectEnd) => {
    const log = openSync(logPath, "a");
    let child: ChildProcess | undefined;
    let settled = false;
    const forwarders = FORWARDED_SIGNALS.map((signal) => ({
      signal,
      forward: () => child?.kill(signal),
    }));
    for (const { signal, forward } of forwarders) process.on(signal, forward);
    const release = (): void => {
      for (const { signal, forward } of forwarders) process.off(signal, forward);
      closeSync(log);
    };
    const finish = (end: SessionEnd): void => {
      if (settled) return;
      settled = true;
      release();
      resolveEnd(end);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      release();
      rejectEnd(error);
    };
    try {
      child = spawn("claude", args, { cwd, env: toChildEnv(env), stdio: ["ignore", log, log] });
    } catch (error) {
      fail(error);
      return;
    }
    let startupError: { cause: unknown } | undefined;
    child.on("error", () => finish({ exitCode: SPAWN_FAILED_EXIT }));
    child.on("close", (code, signal) => {
      if (startupError === undefined) finish(sessionEndOf(code, signal));
      else fail(startupError.cause);
    });
    if (child.pid === undefined) return;
    try {
      onSpawn(child.pid);
    } catch (error) {
      startupError = { cause: error };
      child.kill("SIGKILL");
    }
  });

const realDeps: DispatchDeps = {
  spawnSession: spawnSessionWithClaude,
  runSmoke: runSmokeWithClaude,
  isProcessAlive,
  pid: process.pid,
  print: (line) => console.log(line),
};

const runCommand = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseCliArgs(argv, {
    root: { type: "string" },
    job: { type: "string" },
    tier: { type: "string" },
    model: { type: "string" },
    "no-smoke": { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  const [command, slug, ...extra] = positionals;
  if (extra.length > 0) refuse(`unexpected argument "${extra[0]}"`);
  const root = stringOption(values, "root") ?? process.cwd();
  if (command === "init") {
    console.log(initWorkItem(root, slug));
    return 0;
  }
  if (command === "status") {
    console.log(readRunStatus(root, slug));
    return 0;
  }
  if (command !== "run") refuse("usage: dispatch.ts <init|run|status> <slug> [options]");
  const job = stringOption(values, "job");
  const tier = stringOption(values, "tier");
  if (job === undefined || tier === undefined) refuse("run needs --job and --tier");
  const options: RunOptions = {
    slug: slug ?? "",
    job,
    tier,
    model: stringOption(values, "model"),
    noSmoke: values["no-smoke"] === true,
    dryRun: values["dry-run"] === true,
  };
  return dispatchRun(options, root, process.env, realDeps);
};

const main = async (): Promise<void> => {
  try {
    process.exitCode = await runCommand(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof LkRefusal)) throw error;
    console.error(`LK REFUSED: ${error.message}`);
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
