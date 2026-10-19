/**
 * Sends one push notification through ntfy so the owner hears about a controller session that is
 * waiting for them.
 *
 * Run:  node --import tsx scripts/lk/notify.ts --title <text> --message <text>
 *         [--priority <high|default>] [--dry-run]
 * Hook: node --import tsx scripts/lk/notify.ts --hook [--dry-run]   (one JSON object on stdin)
 *
 * The topic is a secret: it is the only thing between the owner's phone and anyone who guesses it.
 * It is read from a file, used to build the URL and never printed, logged or echoed, including in
 * error text. In hook mode nothing from the payload except the event name is read, so nothing the
 * session produced can reach the push.
 *
 * Exit codes: 0 sent or dry run, 1 bad arguments, 2 no usable topic file, 3 the send failed. Hook
 * mode exits 0 on every failure so a broken alert cannot block the session it reports on.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LkRefusal, parseCliArgs, stringOption, type Env } from "./models";

export const TEXT_LIMIT = 200;
export const NTFY_ORIGIN = "https://ntfy.sh";
const TOPIC_FILE_IN_HOME = ".config/lombakita/ntfy-topic";
const TOPIC_PLACEHOLDER = "<topic>";

export type Priority = "high" | "default";

export interface Alert {
  title: string;
  message: string;
  priority: Priority;
}

export interface NtfyRequest {
  method: "POST";
  url: string;
  headers: { Title: string; Priority: string };
  body: string;
}

export type SendRequest = (request: NtfyRequest) => Promise<{ status: number }>;

export interface NotifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class NotifyFailure extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

const HOOK_ALERTS = new Map<string, Alert>([
  [
    "Stop",
    {
      title: "Lombakita: waiting for you",
      message: "The controller finished a turn and is waiting.",
      priority: "default",
    },
  ],
  [
    "Notification",
    {
      title: "Lombakita: needs you",
      message: "The controller needs a permission or an answer.",
      priority: "default",
    },
  ],
]);

export const cleanText = (text: string): string =>
  Array.from(text.replace(/[\r\n]+/g, " "))
    .slice(0, TEXT_LIMIT)
    .join("");

/** A null topic builds the request the way `--dry-run` shows it, with a placeholder in the URL. */
export const buildRequest = (alert: Alert, topic: string | null): NtfyRequest => ({
  method: "POST",
  url: `${NTFY_ORIGIN}/${topic === null ? TOPIC_PLACEHOLDER : encodeURIComponent(topic)}`,
  headers: { Title: cleanText(alert.title), Priority: alert.priority },
  body: cleanText(alert.message),
});

const topicFilePath = (env: Env): string => {
  const override = env.LK_NTFY_TOPIC_FILE;
  return override !== undefined && override !== "" ? override : join(homedir(), TOPIC_FILE_IN_HOME);
};

const readTopic = (env: Env): string => {
  const path = topicFilePath(env);
  const unusable = new NotifyFailure(
    2,
    `lk-notify: no usable topic file at ${path}, alert NOT sent`,
  );
  let topic: string;
  try {
    topic = readFileSync(path, "utf8").trim();
  } catch {
    throw unusable;
  }
  if (topic === "") throw unusable;
  return topic;
};

const sendThrough = async (send: SendRequest, request: NtfyRequest): Promise<void> => {
  let status: number;
  try {
    status = (await send(request)).status;
  } catch {
    throw new NotifyFailure(3, "lk-notify: send failed (network error), alert NOT sent");
  }
  if (status < 200 || status >= 300) {
    throw new NotifyFailure(3, `lk-notify: send failed (status ${status}), alert NOT sent`);
  }
};

const deliver = async (
  alert: Alert,
  env: Env,
  dryRun: boolean,
  send: SendRequest,
): Promise<NotifyResult> => {
  const topic = readTopic(env);
  if (dryRun) {
    return { exitCode: 0, stdout: `${JSON.stringify(buildRequest(alert, null))}\n`, stderr: "" };
  }
  await sendThrough(send, buildRequest(alert, topic));
  return { exitCode: 0, stdout: "lk-notify: sent\n", stderr: "" };
};

const isPriority = (value: string): value is Priority => value === "high" || value === "default";

const alertFromFlags = (
  title: string | undefined,
  message: string | undefined,
  priority = "default",
) => {
  if (title === undefined || message === undefined) {
    throw new NotifyFailure(1, "lk-notify: --title and --message are required");
  }
  if (!isPriority(priority)) {
    throw new NotifyFailure(1, 'lk-notify: --priority must be "high" or "default"');
  }
  return { title, message, priority };
};

const eventNameOf = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const name = (payload as Record<string, unknown>).hook_event_name;
  return typeof name === "string" ? name : undefined;
};

const runHook = async (
  argv: string[],
  env: Env,
  readStdin: () => string,
  send: SendRequest,
): Promise<NotifyResult> => {
  const quiet: NotifyResult = { exitCode: 0, stdout: "", stderr: "" };
  if (env.LK_ROLE !== "controller") return quiet;
  const { values } = parseCliArgs(argv, {
    hook: { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  let payload: unknown;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    throw new NotifyFailure(0, "lk-notify: hook payload is not JSON, alert NOT sent");
  }
  const alert = HOOK_ALERTS.get(eventNameOf(payload) ?? "");
  if (alert === undefined) return quiet;
  return deliver(alert, env, values["dry-run"] === true, send);
};

const runCli = async (argv: string[], env: Env, send: SendRequest): Promise<NotifyResult> => {
  const { values, positionals } = parseCliArgs(argv, {
    title: { type: "string" },
    message: { type: "string" },
    priority: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  if (positionals.length > 0) throw new NotifyFailure(1, "lk-notify: unexpected argument");
  const alert = alertFromFlags(
    stringOption(values, "title"),
    stringOption(values, "message"),
    stringOption(values, "priority"),
  );
  return deliver(alert, env, values["dry-run"] === true, send);
};

export const runNotify = async (
  argv: string[],
  env: Env,
  readStdin: () => string,
  send: SendRequest,
): Promise<NotifyResult> => {
  const hookMode = argv.includes("--hook");
  try {
    return hookMode ? await runHook(argv, env, readStdin, send) : await runCli(argv, env, send);
  } catch (error) {
    const message =
      error instanceof NotifyFailure
        ? error.message
        : error instanceof LkRefusal
          ? `lk-notify: ${error.message}`
          : "lk-notify: unexpected error, alert NOT sent";
    const exitCode = error instanceof NotifyFailure ? error.exitCode : 1;
    return { exitCode: hookMode ? 0 : exitCode, stdout: "", stderr: `${message}\n` };
  }
};

const sendWithFetch: SendRequest = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return { status: response.status };
};

const main = async (): Promise<void> => {
  const readStdin = (): string => readFileSync(0, "utf8");
  const result = await runNotify(process.argv.slice(2), process.env, readStdin, sendWithFetch);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
