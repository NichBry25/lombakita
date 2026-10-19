// @vitest-environment node

/**
 * The session dispatcher.
 *
 * Command line cases run the real script against a temp repository root with a stand-in `claude`
 * first on PATH, so the exit codes, the files written and the arguments the session receives are
 * the ones a real dispatch produces. In-process cases hand `dispatchRun` injected seams for the
 * parts a command line cannot reach. No case starts a real `claude`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildSmokeArgs,
  DENY_LIST,
  dispatchRun,
  initWorkItem,
  readRunStatus,
  type DispatchDeps,
  type RunOptions,
  type RunRecord,
} from "./dispatch";
import { LkRefusal, type Env } from "./models";

const FIXTURES = join(process.cwd(), "scripts/testing/fixtures/lk");
const STANDARD_MODEL = "claude-test-standard";
const LIGHT_MODEL = "claude-test-light";
const VALID_PROMPT = "Write the result file.\n\nEND OF PROMPT\n";

const workspace = mkdtempSync(join(tmpdir(), "lk-dispatch-"));
const binDir = join(workspace, "bin");
mkdirSync(binDir);
copyFileSync(join(FIXTURES, "fake-claude.sh"), join(binDir, "claude"));
chmodSync(join(binDir, "claude"), 0o755);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  log: string;
  snapshot: string;
}

const makeSandbox = (): Sandbox => {
  const base = mkdtempSync(join(workspace, "sandbox-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "docs/project"), { recursive: true });
  copyFileSync(join(FIXTURES, "models.md"), join(root, "docs/project/models.md"));
  mkdirSync(join(root, ".work"));
  return { root, log: join(base, "calls.log"), snapshot: join(base, "run-snapshot.json") };
};

const addWorkItem = (sandbox: Sandbox, slug: string, prompt = VALID_PROMPT): string => {
  const folder = join(sandbox.root, ".work", slug);
  mkdirSync(folder);
  if (prompt !== "") writeFileSync(join(folder, "02-prompt.md"), prompt);
  return folder;
};

const dispatchEnv = (
  sandbox: Sandbox,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    LK_ROLE: "controller",
    FAKE_CLAUDE_LOG: sandbox.log,
    FAKE_RUN_SNAPSHOT: sandbox.snapshot,
  };
  delete env.LK_SLUG;
  delete env.FAKE_SMOKE;
  delete env.FAKE_MAIN_EXIT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
};

const dispatchArgs = (sandbox: Sandbox, args: string[]): string[] => [
  "--import",
  "tsx",
  "scripts/lk/dispatch.ts",
  ...args,
  "--root",
  sandbox.root,
];

const dispatch = (
  sandbox: Sandbox,
  args: string[],
  overrides: Record<string, string | undefined> = {},
) =>
  spawnSync(process.execPath, dispatchArgs(sandbox, args), {
    encoding: "utf8",
    env: dispatchEnv(sandbox, overrides),
  });

const run = (
  sandbox: Sandbox,
  slug: string,
  extra: string[] = [],
  overrides: Record<string, string | undefined> = {},
) => dispatch(sandbox, ["run", slug, "--job", "implement", "--tier", "1", ...extra], overrides);

interface Call {
  args: string[];
  env: string;
}

const readCalls = (sandbox: Sandbox): Call[] => {
  if (!existsSync(sandbox.log)) return [];
  const calls: Call[] = [];
  for (const token of readFileSync(sandbox.log, "utf8").split("\0")) {
    const last = calls.at(-1);
    if (token === "CALL") calls.push({ args: [], env: "" });
    else if (token.startsWith("ARG ") && last !== undefined) last.args.push(token.slice(4));
    else if (token.startsWith("ENV ") && last !== undefined) last.env = token.slice(4);
  }
  return calls;
};

const readRecord = (sandbox: Sandbox, slug: string): RunRecord =>
  JSON.parse(readFileSync(join(sandbox.root, ".work", slug, "run.json"), "utf8")) as RunRecord;

const lockPath = (sandbox: Sandbox): string => join(sandbox.root, ".work/.lock");

const expectRefused = (
  result: ReturnType<typeof dispatch>,
  message: string | RegExp,
  sandbox: Sandbox,
  slug: string,
): void => {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^LK REFUSED: [^\n]+\n$/);
  if (typeof message === "string") expect(result.stderr).toContain(message);
  else expect(result.stderr).toMatch(message);
  expect(readCalls(sandbox)).toEqual([]);
  expect(existsSync(join(sandbox.root, ".work", slug, "run.json"))).toBe(false);
  expect(existsSync(join(sandbox.root, ".work", slug, "session.jsonl"))).toBe(false);
};

describe("the arguments a session receives", () => {
  it("are exactly the headless flags, the model and the deny list", () => {
    expect(buildClaudeArgs("the prompt", "claude-x")).toEqual([
      "-p",
      "the prompt",
      "--model",
      "claude-x",
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      DENY_LIST,
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("carry a deny list that is exactly the owner's list", () => {
    expect(DENY_LIST).toBe(
      "Bash(git push --force*),Bash(git push -f*),Bash(git -C * push --force*),Bash(git -C * push -f*),Bash(git reset --hard*),Bash(git -C * reset --hard*),Bash(git clean*),Bash(git -C * clean*),Bash(rm -r*),Bash(sudo *),Bash(gh *),Bash(vercel *),Bash(railway *),Bash(npm run db:*)",
    );
    expect(DENY_LIST.split(",")).toHaveLength(14);
  });

  it("make the smoke call a one turn text question", () => {
    expect(buildSmokeArgs("claude-x")).toEqual([
      "-p",
      "reply with the single word ok",
      "--model",
      "claude-x",
      "--max-turns",
      "1",
      "--output-format",
      "text",
    ]);
  });
});

describe("refusals, each before anything is started", () => {
  it.each([undefined, "implementer", "Controller", ""])("refuses when LK_ROLE is %j", (role) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { LK_ROLE: role });
    expectRefused(result, 'LK_ROLE must be "controller" to dispatch', sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("names the role before any other fault", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "Bad_Slug", [], { LK_ROLE: undefined });
    expect(result.stderr).toBe('LK REFUSED: LK_ROLE must be "controller" to dispatch\n');
  });

  it("refuses a slug outside the pattern even when its folder and prompt exist", () => {
    const sandbox = makeSandbox();
    for (const slug of ["Bad_Slug", "step-2", "trail-", "double--dash"]) {
      addWorkItem(sandbox, slug);
      const result = run(sandbox, slug);
      expectRefused(result, `slug "${slug}" does not match`, sandbox, slug);
    }
  });

  it("refuses a slug that climbs out of .work", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "../escape");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match");
  });

  it("refuses a work item with no folder", () => {
    const sandbox = makeSandbox();
    const result = run(sandbox, "ghost");
    expectRefused(result, /no work folder .*\.work\/ghost\n$/, sandbox, "ghost");
  });

  it.each([
    { name: "a missing prompt file", prompt: "", message: "02-prompt.md is missing or empty" },
    { name: "an empty prompt file", prompt: " \n\n", message: "02-prompt.md is missing or empty" },
    {
      name: "a prompt with no end marker",
      prompt: "Do the thing.\n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a prompt cut before the marker",
      prompt: "Do the thing.\nEND OF PRO",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker with trailing text",
      prompt: "Do it.\nEND OF PROMPT.\n",
      message: "does not end with the line END OF PROMPT",
    },
    {
      name: "a marker followed by more text",
      prompt: "END OF PROMPT\nmore\n",
      message: "does not end with the line END OF PROMPT",
    },
  ])("refuses $name", ({ prompt, message }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha", prompt);
    const result = run(sandbox, "alpha");
    expectRefused(result, message, sandbox, "alpha");
  });

  it("accepts blank lines after the marker", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha", "Do it.\n\nEND OF PROMPT\n\n\n");
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(0);
  });

  it.each([
    {
      name: "a job and tier with no row",
      args: ["--job", "review", "--tier", "2"],
      message: "no class for job review tier 2",
    },
    {
      name: "an unknown job",
      args: ["--job", "deploy", "--tier", "1"],
      message: "no class for job deploy tier 1",
    },
    {
      name: "tier any as a request",
      args: ["--job", "lookup", "--tier", "any"],
      message: 'tier must be 1, 2 or 3, not "any"',
    },
    {
      name: "a tier of 4",
      args: ["--job", "lookup", "--tier", "4"],
      message: 'tier must be 1, 2 or 3, not "4"',
    },
  ])("refuses $name", ({ args, message }) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = dispatch(sandbox, ["run", "alpha", ...args]);
    expectRefused(result, message, sandbox, "alpha");
  });

  it("refuses when the model table cannot be read or is damaged", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const table = join(sandbox.root, "docs/project/models.md");
    writeFileSync(table, readFileSync(table, "utf8").replace("claude-test-standard", "NotAModel"));
    expectRefused(run(sandbox, "alpha"), "is not a model id", sandbox, "alpha");
    rmSync(table);
    expectRefused(run(sandbox, "alpha"), "cannot read the model table", sandbox, "alpha");
  });

  it("refuses an override that is not a model id", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--model", "Not A Model"]);
    expectRefused(result, '--model "Not A Model" is not a model id', sandbox, "alpha");
  });

  it("refuses a missing --job or --tier and an unknown command", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    expect(dispatch(sandbox, ["run", "alpha", "--job", "implement"]).stderr).toContain(
      "run needs --job and --tier",
    );
    expect(dispatch(sandbox, ["launch", "alpha"]).stderr).toContain("usage:");
  });
});

describe("the lock", () => {
  it("refuses while a live process holds it and leaves it untouched", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const holder = JSON.stringify({ pid: process.pid, slug: "beta" });
    writeFileSync(lockPath(sandbox), holder);
    const result = run(sandbox, "alpha");
    expectRefused(result, `slug beta holds the lock (pid ${process.pid})`, sandbox, "alpha");
    expect(readFileSync(lockPath(sandbox), "utf8")).toBe(holder);
  });

  it("removes a lock whose process is gone, says so and carries on", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const deadPid = spawnSync("node", ["-e", ""]).pid;
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: deadPid, slug: "old" }));
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LK NOTE: stale lock removed\n");
    expect(readRecord(sandbox, "alpha").status).toBe("done");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses a lock file it cannot read rather than guess it is stale", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), "not json");
    const result = run(sandbox, "alpha");
    expectRefused(result, "is unreadable", sandbox, "alpha");
    expect(existsSync(lockPath(sandbox))).toBe(true);
  });
});

describe("the smoke call", () => {
  it.each(["silent", "fail", "okfail"])("refuses when the model answers in mode %s", (mode) => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { FAKE_SMOKE: mode });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`LK REFUSED: model ${STANDARD_MODEL} did not answer\n`);
    const calls = readCalls(sandbox);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(buildSmokeArgs(STANDARD_MODEL));
    expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
    expect(existsSync(join(sandbox.root, ".work/alpha/session.jsonl"))).toBe(false);
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("asks the model that will run, as an implementer so the controller hooks stay quiet", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    const [smoke] = readCalls(sandbox);
    expect(smoke?.args).toEqual(buildSmokeArgs(STANDARD_MODEL));
    expect(smoke?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha");
  });

  it("is skipped by --no-smoke", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--no-smoke"], { FAKE_SMOKE: "fail" });
    expect(result.status).toBe(0);
    expect(readCalls(sandbox)).toHaveLength(1);
  });
});

describe("--dry-run", () => {
  it("prints the class, model and arguments with the prompt replaced by its length, and writes nothing", () => {
    const sandbox = makeSandbox();
    const folder = addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--dry-run"], { FAKE_SMOKE: "fail" });
    expect(result.status).toBe(0);
    const [head, args] = result.stdout.trimEnd().split("\n");
    expect(head).toBe(
      `LK DRY-RUN alpha job=implement tier=1 class=Standard model=${STANDARD_MODEL} override=false`,
    );
    expect(args).toBe(
      `args: ${JSON.stringify(buildClaudeArgs(`<${VALID_PROMPT.length} characters>`, STANDARD_MODEL))}`,
    );
    expect(readCalls(sandbox)).toEqual([]);
    expect(readdirSync(folder)).toEqual(["02-prompt.md"]);
    expect(readdirSync(join(sandbox.root, ".work"))).toEqual(["alpha"]);
  });

  it("leaves a stale lock in place and says it is there", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const stale = JSON.stringify({ pid: spawnSync("node", ["-e", ""]).pid, slug: "old" });
    writeFileSync(lockPath(sandbox), stale);
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LK NOTE: stale lock present, a real run removes it");
    expect(readFileSync(lockPath(sandbox), "utf8")).toBe(stale);
  });

  it("still refuses a live lock", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: process.pid, slug: "beta" }));
    const result = run(sandbox, "alpha", ["--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("slug beta holds the lock");
  });
});

describe("a real run", () => {
  it("passes the session exactly the built arguments, as an implementer, from the repository root", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("LK DISPATCH alpha done exit 0\n");
    const [, session] = readCalls(sandbox);
    expect(session?.args).toEqual(buildClaudeArgs(VALID_PROMPT, STANDARD_MODEL));
    expect(session?.args).toContain(DENY_LIST);
    expect(session?.args).toContain("bypassPermissions");
    expect(session?.env).toBe("LK_ROLE=implementer LK_SLUG=alpha");
  });

  it("records running while the session runs and done with exit 0 afterwards", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    const during = JSON.parse(readFileSync(sandbox.snapshot, "utf8")) as RunRecord;
    expect(during.status).toBe("running");
    expect(during.exit).toBeUndefined();
    expect(readFileSync(`${sandbox.snapshot}.lock`, "utf8")).toBe("present\n");

    const after = readRecord(sandbox, "alpha");
    expect(after).toMatchObject({
      slug: "alpha",
      job: "implement",
      tier: "1",
      class: "Standard",
      model: STANDARD_MODEL,
      override: false,
      status: "done",
      exit: 0,
    });
    expect(Number.isInteger(after.pid)).toBe(true);
    expect(new Date(after.started).toISOString()).toBe(after.started);
    expect(new Date(after.ended ?? "").toISOString()).toBe(after.ended);
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("appends the session's output to session.jsonl", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha");
    expect(readFileSync(join(sandbox.root, ".work/alpha/session.jsonl"), "utf8")).toBe(
      '{"type":"result"}\n',
    );
  });

  it("records failed with the session's exit code, exits with it and still removes the lock", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", [], { FAKE_MAIN_EXIT: "3" });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("LK DISPATCH alpha failed exit 3\n");
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 3 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("records failed with exit 127 when claude cannot be started", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const result = run(sandbox, "alpha", ["--no-smoke"], { PATH: "/nonexistent" });
    expect(result.status).toBe(127);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 127 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("replaces only the model name with --model and records the override", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    run(sandbox, "alpha", ["--model", "claude-test-other"]);
    const [smoke, session] = readCalls(sandbox);
    expect(smoke?.args).toEqual(buildSmokeArgs("claude-test-other"));
    expect(session?.args).toEqual(buildClaudeArgs(VALID_PROMPT, "claude-test-other"));
    expect(readRecord(sandbox, "alpha")).toMatchObject({
      class: "Standard",
      model: "claude-test-other",
      override: true,
    });
  });

  it("takes the exact tier row over the any row, and the any row when no exact row exists", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    dispatch(sandbox, ["run", "alpha", "--job", "implement", "--tier", "3", "--no-smoke"]);
    dispatch(sandbox, ["run", "beta", "--job", "implement", "--tier", "2", "--no-smoke"]);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ class: "Light", model: LIGHT_MODEL });
    expect(readRecord(sandbox, "beta")).toMatchObject({ class: "Standard", model: STANDARD_MODEL });
  });
});

describe("a session that is still running", () => {
  interface LockFile {
    pid: number;
    slug: string;
    childPid?: number;
  }

  const startDispatch = (sandbox: Sandbox, slug: string, releaseFile: string) => {
    const child = spawn(
      process.execPath,
      dispatchArgs(sandbox, ["run", slug, "--job", "implement", "--tier", "1", "--no-smoke"]),
      { env: dispatchEnv(sandbox, { FAKE_RELEASE_FILE: releaseFile }), stdio: "ignore" },
    );
    const exited = new Promise<{ code: number | null }>((resolveExit) => {
      child.on("exit", (code) => resolveExit({ code }));
    });
    return { child, exited };
  };

  const readLockFile = (sandbox: Sandbox): LockFile | undefined => {
    try {
      return JSON.parse(readFileSync(lockPath(sandbox), "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  };

  const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const lockedChildPid = async (sandbox: Sandbox): Promise<number> => {
    await waitFor(
      () => typeof readLockFile(sandbox)?.childPid === "number",
      "the session pid in the lock",
    );
    return readLockFile(sandbox)?.childPid ?? -1;
  };

  it("writes a lock naming the dispatcher and its session, and a second dispatch refuses against it", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const release = `${sandbox.log}.release`;
    const first = startDispatch(sandbox, "alpha", release);
    try {
      const childPid = await lockedChildPid(sandbox);
      expect(readLockFile(sandbox)).toEqual({ pid: first.child.pid, slug: "alpha", childPid });
      expect(childPid).not.toBe(first.child.pid);
      expect(isAlive(childPid)).toBe(true);

      const second = run(sandbox, "beta", ["--no-smoke"]);
      expect(second.status).toBe(1);
      expect(second.stderr).toBe(
        `LK REFUSED: slug alpha holds the lock (pid ${first.child.pid})\n`,
      );
      expect(existsSync(join(sandbox.root, ".work/beta/run.json"))).toBe(false);
    } finally {
      writeFileSync(release, "");
    }
    expect((await first.exited).code).toBe(0);
    expect(readRecord(sandbox, "alpha").status).toBe("done");
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("passes a termination signal to the session, waits for it, then records failed and frees the lock", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const release = `${sandbox.log}.release`;
    const first = startDispatch(sandbox, "alpha", release);
    try {
      const childPid = await lockedChildPid(sandbox);
      first.child.kill("SIGTERM");
      expect((await first.exited).code).toBe(1);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      writeFileSync(release, "");
    }
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 1 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("keeps refusing after the dispatcher is killed outright while its session lives, and stops when the session ends", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    addWorkItem(sandbox, "beta");
    const release = `${sandbox.log}.release`;
    const first = startDispatch(sandbox, "alpha", release);
    try {
      const childPid = await lockedChildPid(sandbox);
      first.child.kill("SIGKILL");
      await first.exited;
      const refused = run(sandbox, "beta", ["--dry-run"]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toBe(`LK REFUSED: slug alpha holds the lock (pid ${childPid})\n`);

      writeFileSync(release, "");
      await waitFor(() => !isAlive(childPid), "the session to end");
      const allowed = run(sandbox, "beta", ["--dry-run"]);
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toContain("LK NOTE: stale lock present");
    } finally {
      writeFileSync(release, "");
    }
  });
});

describe("init and status", () => {
  it("creates the work folder, prints its path and refuses to create it twice", () => {
    const sandbox = makeSandbox();
    const first = dispatch(sandbox, ["init", "alpha"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(`${join(sandbox.root, ".work/alpha")}\n`);
    expect(existsSync(join(sandbox.root, ".work/alpha"))).toBe(true);
    const second = dispatch(sandbox, ["init", "alpha"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/^LK REFUSED: .*alpha already exists\n$/);
  });

  it("refuses an invalid slug and creates nothing", () => {
    const sandbox = makeSandbox();
    for (const slug of ["Bad_Slug", "pilot-2", "../up"]) {
      const result = dispatch(sandbox, ["init", slug]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not match");
    }
    expect(readdirSync(join(sandbox.root, ".work"))).toEqual([]);
  });

  it("creates the .work folder when the repository has none", () => {
    const sandbox = makeSandbox();
    rmSync(join(sandbox.root, ".work"), { recursive: true });
    expect(dispatch(sandbox, ["init", "alpha"]).status).toBe(0);
    expect(existsSync(join(sandbox.root, ".work/alpha"))).toBe(true);
  });

  it("reports no run, then the run record", () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    expect(dispatch(sandbox, ["status", "alpha"]).stdout).toBe("no run\n");
    run(sandbox, "alpha");
    const status = JSON.parse(dispatch(sandbox, ["status", "alpha"]).stdout) as RunRecord;
    expect(status).toMatchObject({ slug: "alpha", status: "done", exit: 0 });
    expect(dispatch(sandbox, ["status", "Bad_Slug"]).status).toBe(1);
  });
});

describe("dispatchRun with injected seams", () => {
  const options: RunOptions = {
    slug: "alpha",
    job: "implement",
    tier: "1",
    model: undefined,
    noSmoke: false,
    dryRun: false,
  };
  const controllerEnv = { LK_ROLE: "controller", KEEP: "yes" };

  const seams = (overrides: Partial<DispatchDeps> = {}) => {
    const printed: string[] = [];
    const sessions: { args: string[]; cwd: string; env: Env; logPath: string }[] = [];
    const smokes: { model: string; env: Env }[] = [];
    const deps: DispatchDeps = {
      spawnSession: async (args, { cwd, env, logPath }) => {
        sessions.push({ args, cwd, env, logPath });
        return 5;
      },
      runSmoke: (model, smokeOptions) => {
        smokes.push({ model, env: smokeOptions.env });
        return { status: 0, stdout: "ok" };
      },
      isProcessAlive: () => true,
      pid: 4242,
      print: (line) => printed.push(line),
      ...overrides,
    };
    return { deps, printed, sessions, smokes };
  };

  it("hands the session its arguments, working directory, log path and role without starting a process", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps, printed, sessions, smokes } = seams();
    const code = await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(code).toBe(5);
    expect(printed).toEqual(["LK DISPATCH alpha failed exit 5"]);
    expect(sessions).toEqual([
      {
        args: buildClaudeArgs(VALID_PROMPT, STANDARD_MODEL),
        cwd: sandbox.root,
        env: { LK_ROLE: "implementer", LK_SLUG: "alpha", KEEP: "yes" },
        logPath: join(sandbox.root, ".work/alpha/session.jsonl"),
      },
    ]);
    expect(smokes).toEqual([
      { model: STANDARD_MODEL, env: { LK_ROLE: "implementer", LK_SLUG: "alpha", KEEP: "yes" } },
    ]);
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 5, pid: 4242 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("refuses to start when another dispatch takes the lock during the smoke call", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps, sessions } = seams({
      runSmoke: () => {
        writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 1, slug: "rival" }));
        return { status: 0, stdout: "ok" };
      },
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      new LkRefusal("slug rival holds the lock"),
    );
    expect(sessions).toEqual([]);
    expect(existsSync(join(sandbox.root, ".work/alpha/run.json"))).toBe(false);
    expect(readFileSync(lockPath(sandbox), "utf8")).toContain("rival");
  });

  it("removes the lock and records failed when the session cannot be started", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    const { deps } = seams({
      spawnSession: async () => {
        throw new Error("spawn exploded");
      },
    });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      "spawn exploded",
    );
    expect(readRecord(sandbox, "alpha")).toMatchObject({ status: "failed", exit: 1 });
    expect(existsSync(lockPath(sandbox))).toBe(false);
  });

  it("removes a stale lock before it starts and prints the note first", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 99, slug: "old" }));
    const { deps, printed } = seams({ isProcessAlive: () => false });
    await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(printed[0]).toBe("LK NOTE: stale lock removed");
  });

  it("records the session pid in the lock as soon as the session exists", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    let lockWhileRunning: unknown;
    const { deps } = seams({
      spawnSession: async (_args, { onSpawn }) => {
        onSpawn(777);
        lockWhileRunning = JSON.parse(readFileSync(lockPath(sandbox), "utf8"));
        return 0;
      },
    });
    await dispatchRun(options, sandbox.root, controllerEnv, deps);
    expect(lockWhileRunning).toEqual({ pid: 4242, slug: "alpha", childPid: 777 });
  });

  it("treats a lock as held while either the dispatcher or its session is alive", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 4, slug: "old", childPid: 5 }));
    const sessionOnly = seams({ isProcessAlive: (pid) => pid === 5 });
    await expect(
      dispatchRun(options, sandbox.root, controllerEnv, sessionOnly.deps),
    ).rejects.toThrow(new LkRefusal("slug old holds the lock (pid 5)"));

    const neither = seams({ isProcessAlive: () => false });
    await dispatchRun(options, sandbox.root, controllerEnv, neither.deps);
    expect(neither.printed[0]).toBe("LK NOTE: stale lock removed");
  });

  it("refuses a lock whose session pid is not a number", async () => {
    const sandbox = makeSandbox();
    addWorkItem(sandbox, "alpha");
    writeFileSync(lockPath(sandbox), JSON.stringify({ pid: 4, slug: "old", childPid: "5" }));
    const { deps } = seams({ isProcessAlive: () => false });
    await expect(dispatchRun(options, sandbox.root, controllerEnv, deps)).rejects.toThrow(
      "is unreadable",
    );
  });

  it("refuses without the controller role before reading anything", async () => {
    const sandbox = makeSandbox();
    const { deps, sessions, smokes } = seams();
    await expect(
      dispatchRun(options, sandbox.root, { LK_ROLE: "implementer" }, deps),
    ).rejects.toThrow('LK_ROLE must be "controller" to dispatch');
    expect(sessions).toEqual([]);
    expect(smokes).toEqual([]);
  });

  it("initWorkItem and readRunStatus work on the root they are given", () => {
    const sandbox = makeSandbox();
    expect(initWorkItem(sandbox.root, "alpha")).toBe(join(sandbox.root, ".work/alpha"));
    expect(readRunStatus(sandbox.root, "alpha")).toBe("no run");
  });
});
