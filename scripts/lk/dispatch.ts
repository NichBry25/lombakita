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
 * model that does not answer each stop it before anything is written. Every refusal is one line
 * starting `LK REFUSED: ` and exits 1. One session runs at a time, enforced by `.work/.lock`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

export const DENY_LIST =
  "Bash(git push --force*),Bash(git push -f*),Bash(git -C * push --force*),Bash(git -C * push -f*),Bash(git reset --hard*),Bash(git -C * reset --hard*),Bash(git clean*),Bash(git -C * clean*),Bash(rm -r*),Bash(sudo *),Bash(gh *),Bash(vercel *),Bash(railway *),Bash(npm run db:*)";

export const SLUG_PATTERN = /^[a-z]+(-[a-z]+)*$/;
export const END_MARKER = "END OF PROMPT";

const WORK_DIR = ".work";
const LOCK_FILE = ".lock";
const PROMPT_FILE = "02-prompt.md";
const RUN_FILE = "run.json";
const SESSION_LOG_FILE = "session.jsonl";
const MODELS_FILE_IN_ROOT = "docs/project/models.md";
const SMOKE_PROMPT = "reply with the single word ok";

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
  ended?: string;
}

export interface ProcessOptions {
  cwd: string;
  env: Env;
}

/** `onSpawn` receives the session's own pid as soon as the process exists. */
export type SpawnSession = (
  args: string[],
  options: ProcessOptions & { logPath: string; onSpawn: (childPid: number) => void },
) => Promise<number>;

export type RunSmoke = (
  model: string,
  options: ProcessOptions,
) => { status: number | null; stdout: string };

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
  rmSync(lockPath);
  deps.print("LK NOTE: stale lock removed");
};

const writeLock = (root: string, holder: LockHolder): void => {
  const lockPath = workPath(root, LOCK_FILE);
  try {
    writeFileSync(lockPath, JSON.stringify(holder), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    refuse(`slug ${readLock(lockPath).slug} holds the lock`);
  }
};

const recordChildInLock = (root: string, holder: LockHolder, childPid: number): void => {
  writeFileSync(workPath(root, LOCK_FILE), JSON.stringify({ ...holder, childPid }));
};

const writeRunRecord = (root: string, record: RunRecord): void => {
  writeFileSync(workPath(root, record.slug, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`);
};

const sessionEnv = (env: Env, slug: string): Env => ({
  ...env,
  LK_ROLE: "implementer",
  LK_SLUG: slug,
});

const refuseUnlessModelAnswers = (
  model: string,
  options: ProcessOptions,
  runSmoke: RunSmoke,
): void => {
  const { status, stdout } = runSmoke(model, options);
  if (status !== 0 || !/ok/i.test(stdout)) refuse(`model ${model} did not answer`);
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
  env: Env,
  deps: DispatchDeps,
): Promise<number> => {
  const holder: LockHolder = { pid: deps.pid, slug: record.slug };
  writeLock(root, holder);
  let exitCode = 1;
  try {
    writeRunRecord(root, record);
    exitCode = await deps.spawnSession(buildClaudeArgs(promptText, record.model), {
      cwd: root,
      env: sessionEnv(env, record.slug),
      logPath: workPath(root, record.slug, SESSION_LOG_FILE),
      onSpawn: (childPid) => recordChildInLock(root, holder, childPid),
    });
  } finally {
    try {
      const status = exitCode === 0 ? "done" : "failed";
      writeRunRecord(root, { ...record, status, exit: exitCode, ended: new Date().toISOString() });
    } finally {
      rmSync(workPath(root, LOCK_FILE), { force: true });
    }
  }
  return exitCode;
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
  const session = resolveSession(root, options.job, options.tier, options.model);
  refuseIfLockHeld(root, deps, !options.dryRun);
  if (options.dryRun) {
    printDryRun(options, session, promptText, deps.print);
    return 0;
  }
  if (!options.noSmoke) {
    refuseUnlessModelAnswers(
      session.model,
      { cwd: root, env: sessionEnv(env, slug) },
      deps.runSmoke,
    );
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
  const exitCode = await runSession(root, record, promptText, env, deps);
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

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const runSmokeWithClaude: RunSmoke = (model, { cwd, env }) => {
  const result = spawnSync("claude", buildSmokeArgs(model), {
    cwd,
    env: toChildEnv(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
};

const SPAWN_FAILED_EXIT = 127;

// A terminated dispatcher must not leave a running session behind a lock that looks free, so these
// signals go to the session and the dispatcher keeps waiting until it ends.
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const spawnSessionWithClaude: SpawnSession = (args, { cwd, env, logPath, onSpawn }) =>
  new Promise((resolveExit) => {
    const log = openSync(logPath, "a");
    let settled = false;
    const forwarders = FORWARDED_SIGNALS.map((signal) => ({
      signal,
      forward: () => child.kill(signal),
    }));
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      for (const { signal, forward } of forwarders) process.off(signal, forward);
      closeSync(log);
      resolveExit(code);
    };
    const child = spawn("claude", args, {
      cwd,
      env: toChildEnv(env),
      stdio: ["ignore", log, log],
    });
    for (const { signal, forward } of forwarders) process.on(signal, forward);
    if (child.pid !== undefined) onSpawn(child.pid);
    child.on("error", () => finish(SPAWN_FAILED_EXIT));
    child.on("close", (code) => finish(code ?? 1));
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
