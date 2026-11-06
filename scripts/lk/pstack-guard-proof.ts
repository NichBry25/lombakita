/**
 * Proves that the two deny entry strings, which the docs settings file must hold, block a session started in a throwaway folder.
 *
 * Run: node --import tsx scripts/lk/pstack-guard-proof.ts --out <file> [--case <id>]
 *
 * `--out` names a new file: a path that already exists is refused, never truncated. Every session
 * also writes `<out>.<case>.<run>.jsonl` and `<out>.<case>.<run>.stderr.txt` beside it.
 *
 * Each case starts real `claude` sessions in a throwaway git folder under the system temp
 * directory. The denied run holds the case's deny entry in the folder's own settings file and asks
 * the model to call the Agent or the Skill tool once. The control run asks the same thing with no
 * entry. A case passes only when the denied call is refused with the entry's refusal text and the
 * control call goes through, so an entry that was never exercised cannot pass. A model that never
 * makes the call is NOT ATTEMPTED, and a control run that does not go through is INVALID.
 *
 * The main session holds only the Agent and Skill tools and no connector, the tools that write a
 * file are disallowed, and a tool use of any other name in any event, a started agent's included,
 * fails the case. The setup skill writes two files under the home folder when it runs to the end;
 * their hashes are taken before the first session and compared after the last.
 *
 * Every refusal runs before the `--out` file exists and before any session starts. The fixture
 * folders are removed in a `finally` and in the signal path, and what survived is asserted.
 *
 * Each session leaves a transcript folder under ~/.claude/projects, an entry in ~/.claude.json and runs the user-level hooks. None of these is removed here.
 * The SIGNAL and POSTCHECK lines of the signal path go to the console only.
 *
 * Nothing here is a *.test.ts, so `npm run test` never starts a model.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LkRefusal, parseCliArgs, readModels, refuse, resolveJob, stringOption } from "./models";

const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS_FILE = join(PRODUCT_ROOT, "docs/project/models.md");
const SETTINGS_IN_DOCS = ".claude/settings.json";
const FIXTURE_PREFIX = "lk-pstack-guard-proof-";
const CLAUDE_BINARY = "claude";
const SESSION_LIMIT_MS = 300_000;
const KILL_GRACE_MS = 15_000;
const SIGNAL_STOP_WAIT_MS = 2_000;
const VERSION_TIMEOUT_MS = 10_000;
const LOG_FILE_MODE = 0o600;
const SESSION_TOOLS = "Agent,Skill";
const SESSION_TOOL_NAMES = SESSION_TOOLS.split(",");
const DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,Bash";
const MAX_TURNS = "6";
const HOME_FILES = [".claude/rules/pstack-models.md", ".cursor/rules/pstack-models.mdc"] as const;
const TERMINATION_SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
const REFUSED_EXIT_CODE = 2;
const FAILED_EXIT_CODE = 1;

type ToolName = "Agent" | "Skill";
type RunName = "denied" | "denied-retry" | "control";
type Verdict = "PASS" | "FAIL" | "NOT ATTEMPTED" | "INVALID";
type SessionEvent = Record<string, unknown>;

interface ProofCase {
  id: string;
  tool: ToolName;
  entry: string;
  target: string;
  targetField: "subagent_type" | "skill";
  refusalText: string;
  prompt: string;
}

interface ModelCall {
  id: string;
}

interface CallResult {
  isError: boolean;
  text: string;
}

interface DeniedJudgment {
  attempted: boolean;
  refused: boolean;
  timedOut: boolean;
}

interface ControlJudgment {
  attempted: boolean;
  allowed: boolean;
  timedOut: boolean;
}

interface CaseSessionRequest {
  caseId: string;
  run: RunName;
  entry: string | undefined;
  prompt: string;
}

interface SessionRequest extends CaseSessionRequest {
  model: string;
  logPrefix: string;
}

interface SessionOptions {
  claudeBinary?: string;
  limitMs?: number;
  killGraceMs?: number;
  appendLog?: (path: string, chunk: Buffer) => void;
}

interface SessionResult {
  timedOut: boolean;
  log: string;
}

type RunSession = (request: CaseSessionRequest) => Promise<SessionResult>;

interface ForeignToolUse {
  denied: string[];
  control: string[];
}

interface DeniedRun {
  judgment: DeniedJudgment;
  foreign: string[];
}

interface ControlRun {
  judgment: ControlJudgment;
  foreign: string[];
}

interface CaseReport {
  id: string;
  retried: boolean;
  denied: DeniedJudgment | undefined;
  deniedForeign: string[];
  control: ControlJudgment | undefined;
  controlForeign: string[];
  error: string | undefined;
  verdict: Verdict;
}

interface CaseReportParts {
  id: string;
  retried: boolean;
  denied: DeniedRun | undefined;
  control: ControlRun | undefined;
  error: string | undefined;
  verdict: Verdict;
}

interface HomeFileState {
  path: string;
  exists: boolean;
  sha256: string | undefined;
}

type HomeSnapshot = readonly HomeFileState[];

interface SignalTarget {
  on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => unknown;
}

interface SignalDeps {
  runningPids: () => number[];
  stopSession: (pid: number) => void;
  wait: (milliseconds: number) => void;
  killSession: (pid: number) => void;
  fixtureFolders: () => string[];
  removeFixtures: () => void;
  isAlive: (pid: number) => boolean;
  homeFileProblems: () => string[] | undefined;
  print: (line: string) => void;
  exit: (code: number) => void;
}

interface MainDeps {
  runSession: (request: SessionRequest) => Promise<SessionResult>;
  removeFixtureFolder: (folder: string) => void;
  docsRoot: string;
  homeFolder: string;
  modelsFile: string;
  print: (line: string) => void;
  readClaudeVersion: () => string;
  now: () => Date;
  environment: { DENY_PROOF_DOCS_ROOT: string | undefined };
}

interface ProofPlan {
  cases: readonly ProofCase[];
  outPath: string;
  settingsPath: string;
  model: string;
}

export const PROOF_CASES: readonly ProofCase[] = [
  {
    id: "agent-poteto",
    tool: "Agent",
    entry: "Agent(pstack:poteto-agent)",
    target: "pstack:poteto-agent",
    targetField: "subagent_type",
    refusalText: "has been denied by permission rule 'Agent(pstack:poteto-agent)'",
    prompt:
      "Call the Agent tool exactly once with subagent_type set to pstack:poteto-agent and prompt set to: Reply with the single word ok and do nothing else. After that call returns or is refused, reply with the single word done and stop. Do not call any other tool.",
  },
  {
    id: "skill-setup",
    tool: "Skill",
    entry: "Skill(pstack:setup-pstack)",
    target: "pstack:setup-pstack",
    targetField: "skill",
    refusalText: "blocked by permission rules",
    prompt:
      "Call the Skill tool exactly once with skill set to pstack:setup-pstack. After that call returns or is refused, reply with the single word done and stop. Do not call any other tool.",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbsentError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const messageOnOneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, " ");

// ---------------------------------------------------------------------------------------------
// The session: its settings, its arguments, the process that runs it
// ---------------------------------------------------------------------------------------------

export const buildFixtureSettings = (entry: string | undefined): string =>
  `${JSON.stringify({ permissions: { deny: entry === undefined ? [] : [entry] } })}\n`;

export const buildSessionArguments = (prompt: string, model: string): string[] => [
  "-p",
  prompt,
  "--model",
  model,
  "--permission-mode",
  "bypassPermissions",
  "--tools",
  SESSION_TOOLS,
  "--strict-mcp-config",
  "--disallowedTools",
  DISALLOWED_TOOLS,
  "--max-turns",
  MAX_TURNS,
  "--output-format",
  "stream-json",
  "--verbose",
];

const fixtureFolderList: string[] = [];
const runningPids = new Set<number>();

export const fixtureFolders = (): string[] => [...fixtureFolderList];

export const runningSessionPids = (): number[] => [...runningPids];

// An inherited GIT_DIR would make `git init` write into another repository, and GIT_CONFIG_COUNT
// would change what every git command reads, so no GIT_ variable reaches git or a session.
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return environment;
};

const runGit = (args: string[]): string => {
  const result = spawnSync("git", args, { env: gitEnvironment(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const assertFolderIsOwnWorkTree = (folder: string): void => {
  const topLevel = runGit(["-C", folder, "rev-parse", "--show-toplevel"]).trim();
  const expected = realpathSync(folder);
  if (topLevel !== expected) {
    throw new Error(`fixture ${folder} is not its own git work tree: top level is ${topLevel}`);
  }
};

// The folder is listed before git runs, so a fixture whose setup fails is still removed.
export const makeFixture = (entry: string | undefined): string => {
  const folder = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  fixtureFolderList.push(folder);
  runGit(["-C", folder, "init", "-q"]);
  assertFolderIsOwnWorkTree(folder);
  mkdirSync(join(folder, ".claude"));
  writeFileSync(join(folder, SETTINGS_IN_DOCS), buildFixtureSettings(entry));
  return folder;
};

// The system temp directory is a symlink on macOS, so the parent is compared by real path.
export const removeFixtureFolder = (folder: string): void => {
  if (!existsSync(folder)) return;
  const parentIsSystemTemp = realpathSync(dirname(folder)) === realpathSync(tmpdir());
  if (!parentIsSystemTemp || !basename(folder).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`refusing to remove ${folder}`);
  }
  rmSync(folder, { recursive: true, force: true });
};

const createEmptyFileExclusively = (path: string, mode?: number): void => {
  writeFileSync(path, "", { flag: "wx", mode });
};

// A transcript can hold whatever a session printed, so only its owner may read the log files.
const createSessionLogFiles = (logPrefix: string): { jsonlPath: string; stderrPath: string } => {
  const jsonlPath = `${logPrefix}.jsonl`;
  const stderrPath = `${logPrefix}.stderr.txt`;
  createEmptyFileExclusively(jsonlPath, LOG_FILE_MODE);
  try {
    createEmptyFileExclusively(stderrPath, LOG_FILE_MODE);
  } catch (error) {
    rmSync(jsonlPath);
    throw error;
  }
  return { jsonlPath, stderrPath };
};

export const runClaudeSession = async (
  request: SessionRequest,
  options: SessionOptions = {},
): Promise<SessionResult> => {
  const claudeBinary = options.claudeBinary ?? CLAUDE_BINARY;
  const limitMs = options.limitMs ?? SESSION_LIMIT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const appendLog = options.appendLog ?? appendFileSync;
  const { jsonlPath, stderrPath } = createSessionLogFiles(request.logPrefix);
  const fixture = makeFixture(request.entry);
  const child = spawn(claudeBinary, buildSessionArguments(request.prompt, request.model), {
    cwd: fixture,
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid !== undefined) runningPids.add(pid);
  const stdoutChunks: Buffer[] = [];
  let limitReached = false;
  let terminationStarted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let logFailure: { error: unknown } | undefined;
  const terminateWithGrace = (): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  };
  // A log that cannot be written leaves a session nobody can read, so the session is ended and the
  // first write error is what the call rejects with once the process has closed.
  const appendLogOrTerminate = (path: string, chunk: Buffer): void => {
    try {
      appendLog(path, chunk);
    } catch (error) {
      logFailure ??= { error };
      terminateWithGrace();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    appendLogOrTerminate(jsonlPath, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => appendLogOrTerminate(stderrPath, chunk));
  const timedOut = await new Promise<boolean>((resolveRun, rejectRun) => {
    const limitTimer = setTimeout(() => {
      limitReached = true;
      terminateWithGrace();
    }, limitMs);
    const stopWaiting = (): void => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      if (pid !== undefined) runningPids.delete(pid);
    };
    // An error on a started process, a failed kill for one, does not end it: only close does.
    child.on("error", (error) => {
      if (pid !== undefined) return;
      stopWaiting();
      rejectRun(error);
    });
    child.on("close", () => {
      stopWaiting();
      resolveRun(limitReached);
    });
  });
  if (logFailure !== undefined) throw logFailure.error;
  return { timedOut, log: Buffer.concat(stdoutChunks).toString("utf8") };
};

// ---------------------------------------------------------------------------------------------
// Reading a session log and judging it
// ---------------------------------------------------------------------------------------------

const parseObjectLine = (line: string): SessionEvent | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const hasNonObjectMessage = (event: SessionEvent): boolean =>
  "message" in event && !isRecord(event.message);

export const parseSessionLog = (text: string): SessionEvent[] => {
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = parseObjectLine(line);
    if (event === undefined || hasNonObjectMessage(event)) continue;
    events.push(event);
  }
  return events;
};

// A started agent's events carry the id of the call that started it; only the main thread counts.
const isMainThread = (event: SessionEvent): boolean =>
  event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;

const contentBlocksOf = (event: SessionEvent): unknown[] => {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content;
};

const mainThreadBlocks = (events: readonly SessionEvent[], type: string): unknown[] =>
  events.filter((event) => event.type === type && isMainThread(event)).flatMap(contentBlocksOf);

const asModelCall = (block: unknown, testCase: ProofCase): ModelCall | undefined => {
  if (!isRecord(block) || block.type !== "tool_use" || block.name !== testCase.tool) {
    return undefined;
  }
  if (typeof block.id !== "string" || !isRecord(block.input)) return undefined;
  if (block.input[testCase.targetField] !== testCase.target) return undefined;
  return { id: block.id };
};

export const findModelCall = (
  events: readonly SessionEvent[],
  testCase: ProofCase,
): ModelCall | undefined => {
  for (const block of mainThreadBlocks(events, "assistant")) {
    const call = asModelCall(block, testCase);
    if (call !== undefined) return call;
  }
  return undefined;
};

const isTextBlock = (block: unknown): block is { type: "text"; text: string } =>
  isRecord(block) && block.type === "text" && typeof block.text === "string";

const textOfResultContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
};

export const findCallResult = (
  events: readonly SessionEvent[],
  toolUseId: string,
): CallResult | undefined => {
  for (const block of mainThreadBlocks(events, "user")) {
    if (!isRecord(block) || block.type !== "tool_result" || block.tool_use_id !== toolUseId) {
      continue;
    }
    return { isError: block.is_error === true, text: textOfResultContent(block.content) };
  }
  return undefined;
};

const foreignToolNameOf = (block: unknown): string | undefined => {
  if (!isRecord(block) || block.type !== "tool_use") return undefined;
  if (typeof block.name !== "string" || SESSION_TOOL_NAMES.includes(block.name)) return undefined;
  return block.name;
};

// Every thread counts here, a started agent's included: the tool limit of the session is what keeps
// a started agent from writing a file or reaching a connector, and a name outside it breaks that.
export const foreignToolNames = (events: readonly SessionEvent[]): string[] => {
  const names: string[] = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    for (const block of contentBlocksOf(event)) {
      const name = foreignToolNameOf(block);
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  }
  return names;
};

const attemptedCallAndResult = (
  events: readonly SessionEvent[],
  testCase: ProofCase,
): { attempted: boolean; result: CallResult | undefined } => {
  const call = findModelCall(events, testCase);
  if (call === undefined) return { attempted: false, result: undefined };
  return { attempted: true, result: findCallResult(events, call.id) };
};

export const judgeDeniedRun = (
  events: readonly SessionEvent[],
  testCase: ProofCase,
  timedOut: boolean,
): DeniedJudgment => {
  const { attempted, result } = attemptedCallAndResult(events, testCase);
  const refused =
    !timedOut &&
    result !== undefined &&
    result.isError &&
    result.text.includes(testCase.refusalText);
  return { attempted, refused, timedOut };
};

export const judgeControlRun = (
  events: readonly SessionEvent[],
  testCase: ProofCase,
  timedOut: boolean,
): ControlJudgment => {
  const { attempted, result } = attemptedCallAndResult(events, testCase);
  const allowed = !timedOut && result !== undefined && !result.isError;
  return { attempted, allowed, timedOut };
};

const NO_FOREIGN_TOOL_USE: ForeignToolUse = { denied: [], control: [] };

export const verdictOf = (
  denied: DeniedJudgment,
  control: ControlJudgment | undefined,
  foreign: ForeignToolUse = NO_FOREIGN_TOOL_USE,
): Verdict => {
  if (foreign.denied.length > 0 || foreign.control.length > 0) return "FAIL";
  if (denied.timedOut) return "FAIL";
  if (!denied.attempted) return "NOT ATTEMPTED";
  if (!denied.refused) return "FAIL";
  if (control === undefined || control.timedOut || !control.attempted || !control.allowed) {
    return "INVALID";
  }
  return "PASS";
};

// ---------------------------------------------------------------------------------------------
// One case: the denied run, its one retry, the control run
// ---------------------------------------------------------------------------------------------

const sessionRequestFor = (testCase: ProofCase, run: RunName): CaseSessionRequest => ({
  caseId: testCase.id,
  run,
  entry: run === "control" ? undefined : testCase.entry,
  prompt: testCase.prompt,
});

const runDeniedSession = async (
  testCase: ProofCase,
  runSession: RunSession,
  run: "denied" | "denied-retry",
): Promise<DeniedRun> => {
  const { timedOut, log } = await runSession(sessionRequestFor(testCase, run));
  const events = parseSessionLog(log);
  return {
    judgment: judgeDeniedRun(events, testCase, timedOut),
    foreign: foreignToolNames(events),
  };
};

const runControlSession = async (
  testCase: ProofCase,
  runSession: RunSession,
): Promise<ControlRun> => {
  const { timedOut, log } = await runSession(sessionRequestFor(testCase, "control"));
  const events = parseSessionLog(log);
  return {
    judgment: judgeControlRun(events, testCase, timedOut),
    foreign: foreignToolNames(events),
  };
};

const deniedSidePassed = (denied: DeniedJudgment, deniedForeign: readonly string[]): boolean =>
  denied.attempted && denied.refused && !denied.timedOut && deniedForeign.length === 0;

// A run that made no call is tried once more, unless it already broke the tool limit or timed out.
const shouldRetryDeniedRun = (denied: DeniedRun): boolean =>
  !denied.judgment.attempted && !denied.judgment.timedOut && denied.foreign.length === 0;

const buildCaseReport = (parts: CaseReportParts): CaseReport => ({
  id: parts.id,
  retried: parts.retried,
  denied: parts.denied?.judgment,
  deniedForeign: parts.denied?.foreign ?? [],
  control: parts.control?.judgment,
  controlForeign: parts.control?.foreign ?? [],
  error: parts.error,
  verdict: parts.verdict,
});

export const runCase = async (testCase: ProofCase, runSession: RunSession): Promise<CaseReport> => {
  const id = testCase.id;
  let retried = false;
  let denied: DeniedRun;
  try {
    denied = await runDeniedSession(testCase, runSession, "denied");
    if (shouldRetryDeniedRun(denied)) {
      retried = true;
      denied = await runDeniedSession(testCase, runSession, "denied-retry");
    }
  } catch (error) {
    const message = messageOnOneLine(error);
    return buildCaseReport({
      id,
      retried,
      denied: undefined,
      control: undefined,
      error: message,
      verdict: "FAIL",
    });
  }
  if (!deniedSidePassed(denied.judgment, denied.foreign)) {
    const verdict = verdictOf(denied.judgment, undefined, { denied: denied.foreign, control: [] });
    return buildCaseReport({ id, retried, denied, control: undefined, error: undefined, verdict });
  }
  let control: ControlRun;
  try {
    control = await runControlSession(testCase, runSession);
  } catch (error) {
    const message = messageOnOneLine(error);
    return buildCaseReport({
      id,
      retried,
      denied,
      control: undefined,
      error: message,
      verdict: "INVALID",
    });
  }
  const verdict = verdictOf(denied.judgment, control.judgment, {
    denied: denied.foreign,
    control: control.foreign,
  });
  return buildCaseReport({ id, retried, denied, control, error: undefined, verdict });
};

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const controlLineOf = (report: CaseReport): string => {
  if (report.control !== undefined) {
    const { attempted, allowed, timedOut } = report.control;
    return `  control run: attempted=${attempted} allowed=${allowed} timed_out=${timedOut}`;
  }
  const controlThrew = report.denied !== undefined && report.error !== undefined;
  return controlThrew ? "  control run: error" : "  control run: not started";
};

const foreignLinesOf = (run: "denied" | "control", names: readonly string[]): string[] =>
  names.length === 0 ? [] : [`  ${run} run foreign tool use: ${names.join(", ")}`];

export const formatCase = (report: CaseReport): string[] => {
  const lines = [`CASE ${report.id}`];
  if (report.retried) lines.push("  denied run retried: the model did not attempt the call");
  if (report.denied === undefined) {
    lines.push("  denied run: error");
  } else {
    const { attempted, refused, timedOut } = report.denied;
    lines.push(`  denied run: attempted=${attempted} refused=${refused} timed_out=${timedOut}`);
  }
  lines.push(...foreignLinesOf("denied", report.deniedForeign));
  lines.push(controlLineOf(report));
  lines.push(...foreignLinesOf("control", report.controlForeign));
  if (report.error !== undefined) lines.push(`  error: ${report.error}`);
  lines.push(`  verdict: ${report.verdict}`);
  return lines;
};

const isClear = (casesNotPass: number, postcheckFailures: number): boolean =>
  casesNotPass === 0 && postcheckFailures === 0;

export const formatFinalLine = (casesNotPass: number, postcheckFailures: number): string =>
  isClear(casesNotPass, postcheckFailures)
    ? "pstack-guard-proof PASSED"
    : `pstack-guard-proof FAILED (${casesNotPass} cases not PASS, ${postcheckFailures} postcheck failures)`;

export const exitCodeOf = (casesNotPass: number, postcheckFailures: number): 0 | 1 =>
  isClear(casesNotPass, postcheckFailures) ? 0 : FAILED_EXIT_CODE;

// ---------------------------------------------------------------------------------------------
// The docs settings file
// ---------------------------------------------------------------------------------------------

export const readDocsEntries = (docsRoot: string, entries: readonly string[]): string => {
  const settingsPath = resolve(docsRoot, SETTINGS_IN_DOCS);
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    return refuse(`docs settings file is unreadable: ${settingsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(`docs settings file is not valid JSON: ${settingsPath}`);
  }
  const permissions = isRecord(parsed) ? parsed.permissions : undefined;
  const deny = isRecord(permissions) ? permissions.deny : undefined;
  if (!Array.isArray(deny)) {
    return refuse(`docs settings file has no permissions.deny array: ${settingsPath}`);
  }
  const missing = entries.find((entry) => !deny.includes(entry));
  if (missing !== undefined) refuse(`docs settings lack the entry: ${missing}`);
  return settingsPath;
};

// ---------------------------------------------------------------------------------------------
// The home files that the setup skill writes
// ---------------------------------------------------------------------------------------------

const readHomeFile = (path: string): HomeFileState => {
  try {
    const content = readFileSync(path);
    return { path, exists: true, sha256: createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    if (!isAbsentError(error)) throw error;
    return { path, exists: false, sha256: undefined };
  }
};

export const snapshotHomeFiles = (homeFolder: string): HomeSnapshot =>
  HOME_FILES.map((relativePath) => readHomeFile(resolve(homeFolder, relativePath)));

const describeHomeChange = (before: HomeFileState, after: HomeFileState): string | undefined => {
  if (!before.exists && after.exists) return "was created by a session";
  if (before.exists && !after.exists) return "was removed by a session";
  if (before.sha256 !== after.sha256) return "was changed by a session";
  return undefined;
};

export const homeFileProblems = (before: HomeSnapshot, after: HomeSnapshot): string[] =>
  before.flatMap((previous) => {
    const current = after.find((file) => file.path === previous.path);
    if (current === undefined)
      throw new Error(`${previous.path} is missing from the second snapshot`);
    const change = describeHomeChange(previous, current);
    return change === undefined ? [] : [`POSTCHECK FAILED: ${previous.path} ${change}`];
  });

// Set by `main` before the first session and cleared when `main` ends, so a signal that arrives with
// no run in progress has no snapshot to compare against.
let homeSnapshotBeforeSessions: HomeSnapshot | undefined;

const homeProblemsSinceSnapshot = (homeFolder: string): string[] | undefined =>
  homeSnapshotBeforeSessions === undefined
    ? undefined
    : homeFileProblems(homeSnapshotBeforeSessions, snapshotHomeFiles(homeFolder));

// ---------------------------------------------------------------------------------------------
// Teardown and signals
// ---------------------------------------------------------------------------------------------

const waitMilliseconds = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

// A session that has exited is a zombie until this process reaps it, and the signal handler blocks
// the reaping, so a zombie counts as gone.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return !state.stdout.trim().startsWith("Z");
};

const signalSession = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(pid, signal);
  } catch {
    // A session that has already ended needs no signal; a survivor shows in the alive check.
  }
};

const stopSessionByPid = (pid: number): void => signalSession(pid, "SIGTERM");

const killSessionByPid = (pid: number): void => signalSession(pid, "SIGKILL");

const removeFixtureFolders = (removeFolder: (folder: string) => void): void => {
  for (const folder of fixtureFolders()) {
    try {
      removeFolder(folder);
    } catch {
      // One folder that cannot be removed must not stop the others; the survivors are asserted.
    }
  }
};

const existingFolders = (folders: readonly string[]): string[] =>
  folders.filter((folder) => existsSync(folder));

// The sessions are told to stop and given a moment to exit, and one that is still alive is killed,
// before their fixtures go, so nothing is still writing into a folder that is being removed.
export const terminateAfterSignal = (signal: string, exitCode: number, deps: SignalDeps): void => {
  const stoppedPids = deps.runningPids();
  deps.print(`SIGNAL ${signal}: stopping ${stoppedPids.length} running session(s)`);
  for (const pid of stoppedPids) deps.stopSession(pid);
  deps.wait(SIGNAL_STOP_WAIT_MS);
  for (const pid of stoppedPids) {
    if (deps.isAlive(pid)) deps.killSession(pid);
  }
  const fixturesInPlace = existingFolders(deps.fixtureFolders()).length;
  deps.print(
    `SIGNAL: ${stoppedPids.length} session(s) told to stop, ${fixturesInPlace} fixture(s) still in place`,
  );
  deps.print("SIGNAL: removing the fixtures");
  deps.removeFixtures();
  const stillAlive = stoppedPids.filter((pid) => deps.isAlive(pid));
  deps.print(`POSTCHECK after signal: sessions still alive: ${JSON.stringify(stillAlive)}`);
  const stillPresent = existingFolders(deps.fixtureFolders());
  deps.print(`POSTCHECK after signal: fixtures still present: ${JSON.stringify(stillPresent)}`);
  const homeProblems = deps.homeFileProblems();
  const homeProblemsText =
    homeProblems === undefined ? "no snapshot" : JSON.stringify(homeProblems);
  deps.print(`POSTCHECK after signal: home file problems: ${homeProblemsText}`);
  deps.exit(exitCode);
};

export const installSignalHandlers = (target: SignalTarget, deps: SignalDeps): void => {
  for (const [signal, exitCode] of TERMINATION_SIGNALS) {
    target.on(signal, () => terminateAfterSignal(signal, exitCode, deps));
  }
};

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (!isAbsentError(error)) throw error;
    return false;
  }
};

const isExistingDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (!isAbsentError(error)) throw error;
    return false;
  }
};

const selectCases = (caseId: string | undefined): readonly ProofCase[] => {
  if (caseId === undefined) return PROOF_CASES;
  const selected = PROOF_CASES.filter((testCase) => testCase.id === caseId);
  if (selected.length === 0) refuse(`unknown case: ${caseId}`);
  return selected;
};

// Every refusal of the run is raised here, in order, before the `--out` file is created.
const planProof = (argv: string[], deps: MainDeps): ProofPlan => {
  const { values, positionals } = parseCliArgs(argv, {
    out: { type: "string" },
    case: { type: "string" },
  });
  const out = stringOption(values, "out");
  if (out === undefined) refuse("--out is required");
  const [firstPositional] = positionals;
  if (firstPositional !== undefined) refuse(`unexpected argument: ${firstPositional}`);
  const cases = selectCases(stringOption(values, "case"));
  const outPath = resolve(out);
  if (pathExists(outPath)) refuse(`--out names a path that exists: ${outPath}`);
  const outParent = dirname(outPath);
  if (!isExistingDirectory(outParent)) refuse(`--out parent folder does not exist: ${outParent}`);
  const settingsPath = readDocsEntries(
    deps.docsRoot,
    cases.map((testCase) => testCase.entry),
  );
  const model = resolveJob(readModels(deps.modelsFile), "lookup", "3").model;
  return { cases, outPath, settingsPath, model };
};

// An empty value counts as unset, as it does in a shell line that clears the variable.
const docsRootOverrideOf = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

const headerLines = (plan: ProofPlan, deps: MainDeps): string[] => [
  `pstack-guard-proof started ${deps.now().toISOString()}`,
  `claude: ${deps.readClaudeVersion()}`,
  `model: ${plan.model}`,
  `docs settings: ${plan.settingsPath}`,
  `docs root override: ${docsRootOverrideOf(deps.environment.DENY_PROOF_DOCS_ROOT) ?? "none"}`,
];

const runSelectedCases = async (
  plan: ProofPlan,
  deps: MainDeps,
  emit: (line: string) => void,
): Promise<CaseReport[]> => {
  const runSession: RunSession = (request) =>
    deps.runSession({
      ...request,
      model: plan.model,
      logPrefix: `${plan.outPath}.${request.caseId}.${request.run}`,
    });
  const reports: CaseReport[] = [];
  for (const testCase of plan.cases) {
    const report = await runCase(testCase, runSession);
    for (const line of formatCase(report)) emit(line);
    reports.push(report);
  }
  return reports;
};

const postcheckLinesAfterRun = (deps: MainDeps, homeBefore: HomeSnapshot | undefined): string[] => {
  removeFixtureFolders(deps.removeFixtureFolder);
  const survivors = existingFolders(fixtureFolders());
  const survivorLines = survivors.map(
    (folder) => `POSTCHECK FAILED: ${folder} survived its teardown`,
  );
  if (homeBefore === undefined) return survivorLines;
  const homeLines = homeFileProblems(homeBefore, snapshotHomeFiles(deps.homeFolder));
  return [...survivorLines, ...homeLines];
};

const exitCodeAfterFailure = (error: unknown, deps: MainDeps): number => {
  if (error instanceof LkRefusal) {
    deps.print(`pstack-guard-proof REFUSED: ${error.message}`);
    return REFUSED_EXIT_CODE;
  }
  console.error(error instanceof Error ? error.message : String(error));
  return FAILED_EXIT_CODE;
};

export const main = async (argv: string[], deps: MainDeps): Promise<number> => {
  let outPath: string | undefined;
  const emit = (line: string): void => {
    deps.print(line);
    if (outPath !== undefined) appendFileSync(outPath, `${line}\n`);
  };
  let reports: CaseReport[] = [];
  let homeBefore: HomeSnapshot | undefined;
  let failureExitCode: number | undefined;
  let postcheckLines: string[] = [];
  try {
    const plan = planProof(argv, deps);
    createEmptyFileExclusively(plan.outPath);
    outPath = plan.outPath;
    for (const line of headerLines(plan, deps)) emit(line);
    homeBefore = snapshotHomeFiles(deps.homeFolder);
    homeSnapshotBeforeSessions = homeBefore;
    reports = await runSelectedCases(plan, deps, emit);
  } catch (error) {
    failureExitCode = exitCodeAfterFailure(error, deps);
  } finally {
    postcheckLines = postcheckLinesAfterRun(deps, homeBefore);
    homeSnapshotBeforeSessions = undefined;
    for (const line of postcheckLines) emit(line);
  }
  if (failureExitCode !== undefined) return failureExitCode;
  const casesNotPass = reports.filter((report) => report.verdict !== "PASS").length;
  emit(formatFinalLine(casesNotPass, postcheckLines.length));
  return exitCodeOf(casesNotPass, postcheckLines.length);
};

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

const readClaudeVersion = (): string => {
  const result = spawnSync(CLAUDE_BINARY, ["--version"], {
    cwd: PRODUCT_ROOT,
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) return "unknown";
  const firstLine = result.stdout.split("\n")[0]?.trim() ?? "";
  return firstLine === "" ? "unknown" : firstLine;
};

const buildSignalDeps = (homeFolder: string): SignalDeps => ({
  runningPids: runningSessionPids,
  stopSession: stopSessionByPid,
  wait: waitMilliseconds,
  killSession: killSessionByPid,
  fixtureFolders,
  removeFixtures: () => removeFixtureFolders(removeFixtureFolder),
  isAlive,
  homeFileProblems: () => homeProblemsSinceSnapshot(homeFolder),
  print: (line) => console.log(line),
  exit: (code) => process.exit(code),
});

const runAsScript = (): void => {
  const homeFolder = homedir();
  // The variable deny-proof.ts uses to point at a synthetic docs folder. A real run leaves it unset.
  const environment = { DENY_PROOF_DOCS_ROOT: process.env.DENY_PROOF_DOCS_ROOT };
  const deps: MainDeps = {
    runSession: (request) => runClaudeSession(request),
    removeFixtureFolder,
    docsRoot: docsRootOverrideOf(environment.DENY_PROOF_DOCS_ROOT) ?? join(PRODUCT_ROOT, "docs"),
    homeFolder,
    modelsFile: MODELS_FILE,
    print: (line) => console.log(line),
    readClaudeVersion,
    now: () => new Date(),
    environment,
  };
  installSignalHandlers(process, buildSignalDeps(homeFolder));
  main(process.argv.slice(2), deps)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = FAILED_EXIT_CODE;
    });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runAsScript();
