// @vitest-environment node

/**
 * The push notifier, in process with an injected sender and as a real command.
 *
 * No test reaches the network: the in-process cases hand `runNotify` a recording sender, and the
 * command line cases only take paths that stop before a send (an unusable topic file, a dry run, a
 * hook that stays silent).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Env } from "./models";
import { cleanText, runNotify, type NtfyRequest, type SendRequest } from "./notify";

const SECRET_TOPIC = "topic-9f3k2x-secret";
const SECRET_PAYLOAD = "payload-secret-7q1z";

const workspace = mkdtempSync(join(tmpdir(), "lk-notify-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let written = 0;
const topicFile = (content: string): string => {
  written += 1;
  const path = join(workspace, `topic-${written}`);
  writeFileSync(path, content);
  return path;
};

const usableTopicFile = (): string => topicFile(`${SECRET_TOPIC}\n`);

const recordingSender = (status = 200) => {
  const requests: NtfyRequest[] = [];
  const send: SendRequest = async (request) => {
    requests.push(request);
    return { status };
  };
  return { requests, send };
};

const neverSend: SendRequest = async () => {
  throw new Error("send must not be called");
};

const noStdin = (): string => "";

const hookPayload = (event: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ hook_event_name: event, session_id: "s-1", ...extra });

const controllerEnv = (topicPath: string): Env => ({
  LK_ROLE: "controller",
  LK_NTFY_TOPIC_FILE: topicPath,
});

const cli = (args: string[], env: Record<string, string>, input = "") => {
  const base = { ...process.env };
  delete base.LK_ROLE;
  delete base.LK_NTFY_TOPIC_FILE;
  return spawnSync("node", ["--import", "tsx", "scripts/lk/notify.ts", ...args], {
    encoding: "utf8",
    env: { ...base, ...env },
    input,
  });
};

const everythingPrinted = (result: { exitCode: number; stdout: string; stderr: string }): string =>
  `${result.stdout}${result.stderr}`;

describe("text cleaning", () => {
  it("replaces newlines and cuts to 200 characters", () => {
    expect(cleanText("one\ntwo\r\nthree")).toBe("one two three");
    expect(cleanText("x".repeat(250))).toHaveLength(200);
    expect(cleanText("x".repeat(200))).toHaveLength(200);
    expect(cleanText("x".repeat(199))).toHaveLength(199);
  });
});

describe("sending", () => {
  it("posts the message as the body with Title and Priority headers to the topic", async () => {
    const { requests, send } = recordingSender();
    const result = await runNotify(
      ["--title", "Build done", "--message", "All green", "--priority", "high"],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: `https://ntfy.sh/${SECRET_TOPIC}`,
        headers: { Title: "Build done", Priority: "high" },
        body: "All green",
      },
    ]);
  });

  it("uses default priority when none is given", async () => {
    const { requests, send } = recordingSender();
    await runNotify(
      ["--title", "t", "--message", "m"],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    expect(requests[0]?.headers.Priority).toBe("default");
  });

  it("strips newlines and cuts each text to 200 characters", async () => {
    const { requests, send } = recordingSender();
    await runNotify(
      [
        "--title",
        `${"t".repeat(150)}\n${"u".repeat(150)}`,
        "--message",
        `a\nb\r\nc${"z".repeat(300)}`,
      ],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    const [request] = requests;
    expect(request?.headers.Title).toHaveLength(200);
    expect(request?.headers.Title).not.toMatch(/[\r\n]/);
    expect(request?.body).toHaveLength(200);
    expect(request?.body.startsWith("a b c")).toBe(true);
  });

  it("never prints the topic when the send works", async () => {
    const { send } = recordingSender();
    const result = await runNotify(
      ["--title", "t", "--message", "m"],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    expect(everythingPrinted(result)).not.toContain(SECRET_TOPIC);
  });

  it.each([
    { status: 500, exit: 3 },
    { status: 404, exit: 3 },
    { status: 199, exit: 3 },
    { status: 300, exit: 3 },
    { status: 200, exit: 0 },
    { status: 204, exit: 0 },
    { status: 299, exit: 0 },
  ])("exits $exit on an answer of $status", async ({ status, exit }) => {
    const { send } = recordingSender(status);
    const result = await runNotify(
      ["--title", "t", "--message", "m"],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    expect(result.exitCode).toBe(exit);
    if (exit === 3) {
      expect(result.stderr).toBe(`lk-notify: send failed (status ${status}), alert NOT sent\n`);
    }
  });

  it("exits 3 on a network error and does not repeat the error text, which may carry the URL", async () => {
    const send: SendRequest = async (request) => {
      throw new Error(`connect failed for ${request.url}`);
    };
    const result = await runNotify(
      ["--title", "t", "--message", "m"],
      controllerEnv(usableTopicFile()),
      noStdin,
      send,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("lk-notify: send failed (network error), alert NOT sent\n");
    expect(everythingPrinted(result)).not.toContain(SECRET_TOPIC);
  });

  it("exits 1 for a missing title, a bad priority or an unknown option, without a send", async () => {
    const env = controllerEnv(usableTopicFile());
    for (const args of [
      ["--message", "m"],
      ["--title", "t"],
      ["--title", "t", "--message", "m", "--priority", "urgent"],
      ["--title", "t", "--message", "m", "--loud"],
    ]) {
      const result = await runNotify(args, env, noStdin, neverSend);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^lk-notify: /);
    }
  });
});

describe("the topic file", () => {
  const unusable = async (path: string, args = ["--title", "t", "--message", "m"]) =>
    runNotify(args, { LK_NTFY_TOPIC_FILE: path }, noStdin, neverSend);

  it("exits 2 with the loud message when the file is missing", async () => {
    const path = join(workspace, "no-such-topic");
    const result = await unusable(path);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`lk-notify: no usable topic file at ${path}, alert NOT sent\n`);
  });

  it("exits 2 when the file is empty or only whitespace", async () => {
    for (const content of ["", "  \n\t\n"]) {
      const path = topicFile(content);
      const result = await unusable(path);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(`lk-notify: no usable topic file at ${path}, alert NOT sent\n`);
    }
  });

  it.skipIf(process.getuid?.() === 0)("exits 2 when the file cannot be read", async () => {
    const path = usableTopicFile();
    chmodSync(path, 0o000);
    const result = await unusable(path);
    expect(result.exitCode).toBe(2);
    expect(everythingPrinted(result)).not.toContain(SECRET_TOPIC);
  });

  it("exits 2 when the path is a directory", async () => {
    const path = join(workspace, "a-directory");
    mkdirSync(path);
    const result = await unusable(path);
    expect(result.exitCode).toBe(2);
  });

  it("exits 2 as a real command, with the message on stderr and nothing on stdout", () => {
    const path = join(workspace, "absent-for-cli");
    const result = cli(["--title", "t", "--message", "m"], { LK_NTFY_TOPIC_FILE: path });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`lk-notify: no usable topic file at ${path}, alert NOT sent\n`);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the topic out of every output as a real command with an unreadable file",
    () => {
      const path = usableTopicFile();
      chmodSync(path, 0o000);
      const result = cli(["--title", "t", "--message", "m"], { LK_NTFY_TOPIC_FILE: path });
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_TOPIC);
    },
  );
});

describe("--dry-run", () => {
  it("prints the request with a placeholder for the topic and sends nothing", async () => {
    const result = await runNotify(
      ["--title", "t", "--message", "m", "--dry-run"],
      controllerEnv(usableTopicFile()),
      noStdin,
      neverSend,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      method: "POST",
      url: "https://ntfy.sh/<topic>",
      headers: { Title: "t", Priority: "default" },
      body: "m",
    });
    expect(everythingPrinted(result)).not.toContain(SECRET_TOPIC);
  });

  it("shows no topic as a real command", () => {
    const result = cli(["--title", "t", "--message", "m", "--dry-run"], {
      LK_NTFY_TOPIC_FILE: usableTopicFile(),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).url).toBe("https://ntfy.sh/<topic>");
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_TOPIC);
  });
});

describe("hook mode", () => {
  const STOP = {
    title: "Lombakita: waiting for you",
    message: "The controller finished a turn and is waiting.",
  };
  const NOTIFICATION = {
    title: "Lombakita: needs you",
    message: "The controller needs a permission or an answer.",
  };

  it.each([undefined, "implementer", "Controller", ""])(
    "is silent and sends nothing when LK_ROLE is %j",
    async (role) => {
      const env: Record<string, string> = { LK_NTFY_TOPIC_FILE: join(workspace, "never-read") };
      if (role !== undefined) env.LK_ROLE = role;
      const result = await runNotify(["--hook"], env, () => hookPayload("Stop"), neverSend);
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    },
  );

  it.each([
    { event: "Stop", expected: STOP },
    { event: "Notification", expected: NOTIFICATION },
  ])("sends the fixed text for $event", async ({ event, expected }) => {
    const { requests, send } = recordingSender();
    const result = await runNotify(
      ["--hook"],
      controllerEnv(usableTopicFile()),
      () => hookPayload(event),
      send,
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: `https://ntfy.sh/${SECRET_TOPIC}`,
        headers: { Title: expected.title, Priority: "default" },
        body: expected.message,
      },
    ]);
  });

  it("sends nothing from the payload", async () => {
    const { requests, send } = recordingSender();
    const payload = hookPayload("Stop", {
      message: SECRET_PAYLOAD,
      title: SECRET_PAYLOAD,
      last_assistant_message: SECRET_PAYLOAD,
      transcript_path: `/tmp/${SECRET_PAYLOAD}`,
      tool_input: { command: SECRET_PAYLOAD },
    });
    await runNotify(["--hook"], controllerEnv(usableTopicFile()), () => payload, send);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(SECRET_PAYLOAD);
  });

  it.each(["PreToolUse", "SessionStart", "", "toString", "constructor", "__proto__"])(
    "exits 0 silently for the event name %j",
    async (event) => {
      const result = await runNotify(
        ["--hook"],
        controllerEnv(usableTopicFile()),
        () => hookPayload(event),
        neverSend,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    },
  );

  it("exits 0 silently when the payload has no event name or is not an object", async () => {
    for (const payload of ["{}", "[]", "null", '"Stop"', '{"hook_event_name":7}']) {
      const result = await runNotify(
        ["--hook"],
        controllerEnv(usableTopicFile()),
        () => payload,
        neverSend,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  it("exits 0 with a warning when the payload is not JSON, without repeating it", async () => {
    const result = await runNotify(
      ["--hook"],
      controllerEnv(usableTopicFile()),
      () => SECRET_PAYLOAD,
      neverSend,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("lk-notify: hook payload is not JSON, alert NOT sent\n");
  });

  it("exits 0 with a warning when the topic file is unusable", async () => {
    const path = join(workspace, "hook-absent-topic");
    const env = controllerEnv(path);
    const result = await runNotify(["--hook"], env, () => hookPayload("Stop"), neverSend);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(`lk-notify: no usable topic file at ${path}, alert NOT sent\n`);
  });

  it("exits 0 with a warning when the send fails or throws", async () => {
    const failing = recordingSender(500);
    const failed = await runNotify(
      ["--hook"],
      controllerEnv(usableTopicFile()),
      () => hookPayload("Stop"),
      failing.send,
    );
    expect(failed.exitCode).toBe(0);
    expect(failed.stderr).toBe("lk-notify: send failed (status 500), alert NOT sent\n");

    const throwing: SendRequest = async () => {
      throw new Error("offline");
    };
    const threw = await runNotify(
      ["--hook"],
      controllerEnv(usableTopicFile()),
      () => hookPayload("Stop"),
      throwing,
    );
    expect(threw.exitCode).toBe(0);
    expect(threw.stderr).toBe("lk-notify: send failed (network error), alert NOT sent\n");
  });

  it("exits 0 when stdin cannot be read or the arguments are wrong", async () => {
    const unreadable = await runNotify(
      ["--hook"],
      controllerEnv(usableTopicFile()),
      () => {
        throw new Error("EAGAIN");
      },
      neverSend,
    );
    expect(unreadable.exitCode).toBe(0);
    const badArgs = await runNotify(
      ["--hook", "--loud"],
      controllerEnv(usableTopicFile()),
      () => hookPayload("Stop"),
      neverSend,
    );
    expect(badArgs.exitCode).toBe(0);
  });

  it("prints the fixed request and nothing from the payload as a real command with --dry-run", () => {
    const result = cli(
      ["--hook", "--dry-run"],
      { LK_ROLE: "controller", LK_NTFY_TOPIC_FILE: usableTopicFile() },
      hookPayload("Stop", { last_assistant_message: SECRET_PAYLOAD }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      method: "POST",
      url: "https://ntfy.sh/<topic>",
      headers: { Title: STOP.title, Priority: "default" },
      body: STOP.message,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_PAYLOAD);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_TOPIC);
  });

  it("is silent as a real command when LK_ROLE is not controller", () => {
    const result = cli(["--hook"], { LK_ROLE: "implementer" }, hookPayload("Stop"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 0 as a real command when the topic file is missing", () => {
    const result = cli(
      ["--hook"],
      { LK_ROLE: "controller", LK_NTFY_TOPIC_FILE: join(workspace, "none") },
      hookPayload("Notification"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^lk-notify: no usable topic file at /);
  });
});
