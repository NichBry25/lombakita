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
 * Exit codes: 0 sent or dry run, 1 bad arguments, 2 no usable topic file, 3 the send failed or took
 * longer than SEND_TIMEOUT_SECONDS. Hook mode exits 0 on every failure so a broken alert cannot
 * block the session it reports on.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { LkRefusal, parseCliArgs, stringOption, type Env } from "./models";

export const TEXT_LIMIT = 200;
export const SEND_TIMEOUT_SECONDS = 10;
const LATIN1_LAST_CODE_POINT = 0xff;
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

/** `signal` aborts when the send has waited too long; a sender should hand it to the request. */
export type SendRequest = (
  request: NtfyRequest,
  signal: AbortSignal,
) => Promise<{ status: number }>;

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

const sendThrough = async (
  send: SendRequest,
  request: NtfyRequest,
  timeoutSeconds: number,
): Promise<void> => {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("send timed out"));
    }, timeoutSeconds * 1000);
  });
  let status: number;
  try {
    status = (await Promise.race([send(request, controller.signal), expiry])).status;
  } catch {
    throw timedOut
      ? new NotifyFailure(
          3,
          `lk-notify: send failed (timeout after ${timeoutSeconds} seconds), alert NOT sent`,
        )
      : new NotifyFailure(3, "lk-notify: send failed (network error), alert NOT sent");
  } finally {
    clearTimeout(timer);
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
  timeoutSeconds: number,
): Promise<NotifyResult> => {
  const topic = readTopic(env);
  if (dryRun) {
    return { exitCode: 0, stdout: `${JSON.stringify(buildRequest(alert, null))}\n`, stderr: "" };
  }
  await sendThrough(send, buildRequest(alert, topic), timeoutSeconds);
  return { exitCode: 0, stdout: "lk-notify: sent\n", stderr: "" };
};

const isPriority = (value: string): value is Priority => value === "high" || value === "default";

// A header value is Latin-1 on the wire, so a wider character would fail inside the request.
const hasCharacterAboveLatin1 = (text: string): boolean =>
  Array.from(text).some((character) => (character.codePointAt(0) ?? 0) > LATIN1_LAST_CODE_POINT);

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
  if (hasCharacterAboveLatin1(cleanText(title))) {
    throw new NotifyFailure(
      1,
      "lk-notify: --title has a character above U+00FF, a header cannot carry it, alert NOT sent",
    );
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
  timeoutSeconds: number,
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
  return deliver(alert, env, values["dry-run"] === true, send, timeoutSeconds);
};

const runCli = async (
  argv: string[],
  env: Env,
  send: SendRequest,
  timeoutSeconds: number,
): Promise<NotifyResult> => {
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
  return deliver(alert, env, values["dry-run"] === true, send, timeoutSeconds);
};

// Parsed rather than searched: `--message --hook` makes the flag the message's value.
const isHookFlagGiven = (argv: string[]): boolean => {
  try {
    const { tokens = [] } = parseArgs({
      args: argv,
      options: {
        hook: { type: "boolean" },
        title: { type: "string" },
        message: { type: "string" },
        priority: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    return tokens.some((token) => token.kind === "option" && token.name === "hook");
  } catch {
    return false;
  }
};

export const runNotify = async (
  argv: string[],
  env: Env,
  readStdin: () => string,
  send: SendRequest,
  timeoutSeconds = SEND_TIMEOUT_SECONDS,
): Promise<NotifyResult> => {
  const hookMode = isHookFlagGiven(argv);
  try {
    return hookMode
      ? await runHook(argv, env, readStdin, send, timeoutSeconds)
      : await runCli(argv, env, send, timeoutSeconds);
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

export const sendWithFetch: SendRequest = async (request, signal) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
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
