/**
 * Prints the usage of one work item: its implementer sessions and its subagent sessions.
 *
 * Run: npm run lk:usage -- <work item slug>   (from the repository root)
 *
 * It reads .work/<slug>/session.jsonl, the stream of the implementer's result events, and
 * .work/<slug>/usage.tsv, one row per subagent session, and writes nothing. A missing file is
 * reported as a line and is not an error. The controller is not measured. The last two lines of a
 * present session log count the lines that could not be read and the result events whose usage
 * could not be read.
 * A usage file that is malformed, a work folder that does not exist, a working directory without a
 * package.json and a wrong argument count are refused through `refuse` from ./models: one line
 * starting `LK REFUSED: ` on stderr, exit 1, nothing on stdout.
 *
 * One session can write several result events, and each carries a running `total_cost_usd`, so the
 * cost of a session is the sum of the `costUSD` of every model entry of every result event.
 * A result event whose usage is missing or malformed still counts as a result with its duration and
 * turns, adds no tokens and no cost, and is counted as a result without usage data.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LkRefusal, parseCliArgs, refuse } from "./models";

export const USAGE_ROLES = [
  "design-read",
  "prompt-review",
  "review-a",
  "review-b",
  "re-review",
  "cold-read",
  "drift-check",
  "drafter",
  "lookup",
  "other",
] as const;

export const USAGE_HEADER = "date\trole\tlabel\ttokens\ttool_uses\tduration_ms";

/** What the summary reads. A line or row that none of these classifies is counted or refused. */
export const SUBJECT = {
  sessionLog: {
    resultType: "result",
    usageKey: "model_usage_since_last_result",
    modelUsageNumberKeys: [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "costUSD",
    ],
  },
  slug: /^[a-z0-9-]+$/,
  usageFile: { fieldCount: 6, date: /^\d{4}-\d{2}-\d{2}$/, count: /^\d+$/ },
  files: {
    folder: (slug: string): string => `.work/${slug}`,
    sessionLog: (slug: string): string => `.work/${slug}/session.jsonl`,
    usageFile: (slug: string): string => `.work/${slug}/usage.tsv`,
  },
  millisecondsPerMinute: 60000,
  idPrefixLength: 8,
} as const;

type UsageRole = (typeof USAGE_ROLES)[number];

interface SessionSummary {
  sessionId: string;
  results: number;
  durationMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionLogSummary {
  sessions: SessionSummary[];
  unparsedLines: number;
  resultsWithoutUsage: number;
}

export interface UsageRow {
  date: string;
  role: UsageRole;
  label: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrZero = (value: unknown): number => (typeof value === "number" ? value : 0);

const splitLines = (text: string): string[] => text.split(/\r?\n/);

const emptySession = (sessionId: string): SessionSummary => ({
  sessionId,
  results: 0,
  durationMs: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
});

const isReadableModelUsage = (usage: unknown): usage is JsonRecord =>
  isRecord(usage) &&
  SUBJECT.sessionLog.modelUsageNumberKeys.every(
    (key) => !(key in usage) || typeof usage[key] === "number",
  );

/** Null when the event has no usage object or any model entry in it cannot be read. */
const readableModelUsagesOf = (event: JsonRecord): JsonRecord[] | null => {
  const usageByModel = event[SUBJECT.sessionLog.usageKey];
  if (!isRecord(usageByModel)) return null;
  const usages = Object.values(usageByModel);
  return usages.every(isReadableModelUsage) ? usages : null;
};

const addModelUsage = (session: SessionSummary, usage: JsonRecord): void => {
  session.inputTokens += numberOrZero(usage.inputTokens);
  session.outputTokens += numberOrZero(usage.outputTokens);
  session.cacheReadTokens += numberOrZero(usage.cacheReadInputTokens);
  session.cacheCreationTokens += numberOrZero(usage.cacheCreationInputTokens);
  session.costUsd += numberOrZero(usage.costUSD);
};

const addResultTotals = (session: SessionSummary, event: JsonRecord): void => {
  session.results += 1;
  session.durationMs += numberOrZero(event.duration_ms);
  session.turns += numberOrZero(event.num_turns);
};

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

export const summarizeSessionLog = (text: string): SessionLogSummary => {
  const sessionsById = new Map<string, SessionSummary>();
  let unparsedLines = 0;
  let resultsWithoutUsage = 0;
  for (const line of splitLines(text)) {
    if (line.trim() === "") continue;
    const event = parseJsonLine(line);
    if (!isRecord(event)) {
      unparsedLines += 1;
      continue;
    }
    if (event.type !== SUBJECT.sessionLog.resultType) continue;
    if (typeof event.session_id !== "string") {
      unparsedLines += 1;
      continue;
    }
    const session = sessionsById.get(event.session_id) ?? emptySession(event.session_id);
    sessionsById.set(event.session_id, session);
    addResultTotals(session, event);
    const usages = readableModelUsagesOf(event);
    if (usages === null) {
      resultsWithoutUsage += 1;
      continue;
    }
    for (const usage of usages) addModelUsage(session, usage);
  }
  return { sessions: [...sessionsById.values()], unparsedLines, resultsWithoutUsage };
};

const requireNonNegativeInteger = (column: string, value: string, where: string): number => {
  if (!SUBJECT.usageFile.count.test(value)) {
    return refuse(`${where}: ${column} "${value}" is not a non-negative integer`);
  }
  return Number(value);
};

const isUsageRole = (value: string): value is UsageRole =>
  (USAGE_ROLES as readonly string[]).includes(value);

const parseUsageRow = (line: string, lineNumber: number, displayPath: string): UsageRow => {
  const where = `${displayPath} line ${lineNumber}`;
  const fields = line.split("\t");
  if (fields.length !== SUBJECT.usageFile.fieldCount) {
    refuse(`${where}: expected 6 tab-separated fields, found ${fields.length}`);
  }
  const [date = "", role = "", label = "", tokens = "", toolUses = "", durationMs = ""] = fields;
  if (!SUBJECT.usageFile.date.test(date)) refuse(`${where}: date "${date}" is not YYYY-MM-DD`);
  if (!isUsageRole(role)) return refuse(`${where}: unknown role "${role}"`);
  return {
    date,
    role,
    label,
    tokens: requireNonNegativeInteger("tokens", tokens, where),
    toolUses: requireNonNegativeInteger("tool_uses", toolUses, where),
    durationMs: requireNonNegativeInteger("duration_ms", durationMs, where),
  };
};

export const parseUsageFile = (text: string, displayPath: string): UsageRow[] => {
  const lines = splitLines(text);
  if ((lines[0] ?? "").trimEnd() !== USAGE_HEADER) {
    refuse(
      `${displayPath} line 1: the header must be date, role, label, tokens, tool_uses and duration_ms separated by tabs`,
    );
  }
  const rows: UsageRow[] = [];
  lines.forEach((line, index) => {
    if (index === 0 || line.trim() === "") return;
    rows.push(parseUsageRow(line, index + 1, displayPath));
  });
  return rows;
};

const minutesOf = (durationMs: number): string =>
  (durationMs / SUBJECT.millisecondsPerMinute).toFixed(1);

const sumOf = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);

const sessionLines = (sessions: SessionSummary[]): string[] =>
  sessions.map((session) => {
    const id = session.sessionId.slice(0, SUBJECT.idPrefixLength);
    return `implementer session ${id}: ${session.results} results, ${session.turns} turns, ${minutesOf(session.durationMs)} minutes, output ${session.outputTokens} tokens, cost $${session.costUsd.toFixed(2)}`;
  });

const implementerLines = (slug: string, sessionLog: SessionLogSummary | null): string[] => {
  if (sessionLog === null) {
    return [`implementer: no session log at ${SUBJECT.files.sessionLog(slug)}`];
  }
  const { sessions } = sessionLog;
  if (sessions.length === 0) {
    return [`implementer: no result events in ${SUBJECT.files.sessionLog(slug)}`];
  }
  const turns = sumOf(sessions.map((session) => session.turns));
  const durationMs = sumOf(sessions.map((session) => session.durationMs));
  const output = sumOf(sessions.map((session) => session.outputTokens));
  const input = sumOf(sessions.map((session) => session.inputTokens));
  const cacheRead = sumOf(sessions.map((session) => session.cacheReadTokens));
  const cacheCreation = sumOf(sessions.map((session) => session.cacheCreationTokens));
  const cost = sumOf(sessions.map((session) => session.costUsd));
  const total = `implementer: ${sessions.length} sessions, ${turns} turns, ${minutesOf(durationMs)} minutes, output ${output} tokens, input ${input}, cache read ${cacheRead}, cache write ${cacheCreation}, cost $${cost.toFixed(2)} at list price`;
  return [total, ...sessionLines(sessions)];
};

const subagentTotalsLine = (label: string, rows: UsageRow[]): string => {
  const tokens = sumOf(rows.map((row) => row.tokens));
  const toolUses = sumOf(rows.map((row) => row.toolUses));
  const durationMs = sumOf(rows.map((row) => row.durationMs));
  return `subagent ${label}: ${rows.length} sessions, ${tokens} tokens, ${toolUses} tool uses, ${minutesOf(durationMs)} minutes`;
};

const subagentLines = (slug: string, usageRows: UsageRow[] | null): string[] => {
  if (usageRows === null) return [`subagent: no usage file at ${SUBJECT.files.usageFile(slug)}`];
  const roleLines = USAGE_ROLES.flatMap((role) => {
    const rowsOfRole = usageRows.filter((row) => row.role === role);
    return rowsOfRole.length === 0 ? [] : [subagentTotalsLine(role, rowsOfRole)];
  });
  return [...roleLines, subagentTotalsLine("total", usageRows)];
};

export const usageReportLinesOf = (
  slug: string,
  sessionLog: SessionLogSummary | null,
  usageRows: UsageRow[] | null,
): string[] => {
  const logCountLines =
    sessionLog === null
      ? []
      : [
          `unparsed session log lines: ${sessionLog.unparsedLines}`,
          `results without usage data: ${sessionLog.resultsWithoutUsage}`,
        ];
  return [
    `lk-usage ${slug}`,
    ...implementerLines(slug, sessionLog),
    ...subagentLines(slug, usageRows),
    "controller: not measured",
    ...logCountLines,
  ];
};

const slugFromArgs = (args: string[]): string => {
  const { positionals } = parseCliArgs(args, {});
  const [slug] = positionals;
  if (slug === undefined) return refuse("give one work item slug");
  if (positionals.length > 1) refuse(`unexpected argument "${positionals[1]}"`);
  if (!SUBJECT.slug.test(slug)) {
    refuse(`the slug "${slug}" is not lowercase letters, digits and hyphens`);
  }
  return slug;
};

const requireRepositoryRoot = (root: string): void => {
  if (existsSync(join(root, "package.json"))) return;
  refuse(`the current directory ${root} holds no package.json, so it is not the repository root`);
};

const requireWorkFolder = (root: string, slug: string): void => {
  const folder = SUBJECT.files.folder(slug);
  const isFolder = existsSync(join(root, folder)) && statSync(join(root, folder)).isDirectory();
  if (!isFolder) refuse(`no work folder at ${folder}`);
};

const readTextOrNull = (root: string, path: string): string | null => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

const main = (): void => {
  try {
    const root = process.cwd();
    requireRepositoryRoot(root);
    const slug = slugFromArgs(process.argv.slice(2));
    requireWorkFolder(root, slug);
    const logText = readTextOrNull(root, SUBJECT.files.sessionLog(slug));
    const usageText = readTextOrNull(root, SUBJECT.files.usageFile(slug));
    const sessionLog = logText === null ? null : summarizeSessionLog(logText);
    const usageFilePath = SUBJECT.files.usageFile(slug);
    const usageRows = usageText === null ? null : parseUsageFile(usageText, usageFilePath);
    console.log(usageReportLinesOf(slug, sessionLog, usageRows).join("\n"));
  } catch (error) {
    if (!(error instanceof LkRefusal)) throw error;
    console.error(`LK REFUSED: ${error.message}`);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
