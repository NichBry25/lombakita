// @vitest-environment node

/**
 * The verdict logic of the deny-proof harness, without a model.
 *
 * The harness runs as a child process, the way it is used, with a stand-in `claude` first on PATH
 * (scripts/testing/fixtures/lk/fake-session-claude.sh) that refuses or runs the one command it is
 * handed. Each case below shapes that stand-in so the harness must reach one verdict, and reads the
 * verdict from the output file. HOME points at an empty folder, so the topic decoys never touch the
 * real one. Whether a real model behaves this way is what the real sessions prove, not these tests.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildClaudeArgs, DENY_LIST, DENY_PATTERNS } from "./dispatch";
import { controlArgs, uneditedHookText } from "./deny-proof";

vi.mock("./dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatch")>();
  return { ...actual, buildClaudeArgs: vi.fn(actual.buildClaudeArgs) };
});

const FIXTURES = join(process.cwd(), "scripts/testing/fixtures/lk");
const SESSION_TEST_TIMEOUT_MS = 60_000;

const workspace = mkdtempSync(join(tmpdir(), "lk-deny-proof-test-"));
const binDir = join(workspace, "bin");
const homeDir = join(workspace, "home");
const scratchDir = join(workspace, "tmp");
mkdirSync(binDir);
mkdirSync(homeDir);
mkdirSync(scratchDir);
copyFileSync(join(FIXTURES, "fake-session-claude.sh"), join(binDir, "claude"));
chmodSync(join(binDir, "claude"), 0o755);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let outputCounter = 0;

// Runs one case of the real harness against the stand-in session and returns its output file.
const runHarness = (group: string, caseId: string, session: Record<string, string>): string => {
  outputCounter += 1;
  const out = join(workspace, `out-${outputCounter}.txt`);
  spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/lk/deny-proof.ts",
      "--group",
      group,
      "--case",
      caseId,
      "--out",
      out,
      "--models",
      join(FIXTURES, "models.md"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: scratchDir,
        ...session,
      },
    },
  );
  return readFileSync(out, "utf8");
};

const verdictOf = (output: string, caseId: string): string | undefined =>
  output
    .split("\n")
    .find((line) => line.startsWith(`RESULT ${caseId}: `))
    ?.slice(`RESULT ${caseId}: `.length);

const ALL_TOPIC_RULES = [
  "Edit(~/.config/lombakita/**)",
  "Write(~/.config/lombakita/**)",
  "Read(~/.config/lombakita/**)",
];

describe("the denied-case verdicts", () => {
  it(
    "is PASS when the denied run is refused and the control run does the harm",
    () => {
      const output = runHarness("rm-a", "rm-fr", { FAKE_REFUSE_IF_LISTED: "Bash(rm -fr*)" });
      expect(verdictOf(output, "rm-fr")).toBe("PASS");
      expect(output).toContain("harm in the denied run: none");
      expect(output).toContain("harm in the control run: files under victim/ are gone");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is INVALID when the control run does no harm, so the refusal proves nothing",
    () => {
      const output = runHarness("rm-a", "rm-fr", {
        FAKE_REFUSE_IF_LISTED: "Bash(rm -fr*)",
        FAKE_HARMLESS: "1",
      });
      expect(verdictOf(output, "rm-fr")).toBe("INVALID");
      expect(output).toContain("harm in the control run: none");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when the denied run is not refused and does the harm",
    () => {
      const output = runHarness("rm-a", "rm-fr", {});
      expect(verdictOf(output, "rm-fr")).toBe("FAIL");
      expect(output).toContain("harm in the denied run: files under victim/ are gone");
      expect(output).not.toContain("- control run");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is NOT ATTEMPTED, after one retry, when the session never tries the command",
    () => {
      const output = runHarness("rm-a", "rm-fr", { FAKE_SILENT: "1" });
      expect(verdictOf(output, "rm-fr")).toBe("NOT ATTEMPTED");
      expect(output).toContain("the model did not attempt the command; one retry");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the lone-rule verdict", () => {
  it(
    "is PASS when the rule that stays refuses the command on its own",
    () => {
      const output = runHarness("topic-write", "edit-tool", {
        FAKE_REFUSE_IF_LISTED: "Edit(~/.config/lombakita/**)",
      });
      expect(output).toContain("- lone-rule run");
      expect(verdictOf(output, "edit-tool")).toBe("PASS");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when the command gets through once the other rules are dropped",
    () => {
      const output = runHarness("topic-write", "edit-tool", {
        FAKE_REFUSE_IF_LISTED: ALL_TOPIC_RULES.join(","),
      });
      expect(output).toContain("- lone-rule run");
      expect(output).toContain("harm in the lone-rule run:");
      expect(output).not.toContain("harm in the lone-rule run: none");
      expect(verdictOf(output, "edit-tool")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the allowed-control verdict", () => {
  it(
    "is ALLOWED OK when the command ran and nothing refused it",
    () => {
      const output = runHarness("allowed", "ok-rm-plain", {});
      expect(verdictOf(output, "ok-rm-plain")).toBe("ALLOWED OK");
      expect(output).toContain("effect: keep.txt was removed");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when a denial names the command",
    () => {
      const output = runHarness("allowed", "ok-rm-plain", {
        FAKE_REFUSE_IF_LISTED: "Bash(sudo *)",
      });
      expect(verdictOf(output, "ok-rm-plain")).toBe("FAIL");
      expect(output).toContain("denial names the command=true");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when nothing refused the command but it had no effect",
    () => {
      const output = runHarness("allowed", "ok-rm-plain", { FAKE_HARMLESS: "1" });
      expect(verdictOf(output, "ok-rm-plain")).toBe("FAIL");
      expect(output).toContain("effect: none");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "reads an effect that is only in the command's output",
    () => {
      const output = runHarness("allowed", "ok-status", {});
      expect(verdictOf(output, "ok-status")).toBe("ALLOWED OK");
      expect(output).toContain("effect: the output holds On branch");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the control run's arguments", () => {
  const withBuiltArguments = (built: string[]): void => {
    vi.mocked(buildClaudeArgs).mockReturnValueOnce(built);
  };

  it("carry the deny list minus exactly the covering patterns", () => {
    const covers = ["Bash(rm -fr*)", "Bash(rm -Rf*)"];
    const args = controlArgs("the prompt", "claude-x", covers);
    const list = args[args.indexOf("--disallowedTools") + 1]?.split(",");
    expect(list).toEqual(DENY_PATTERNS.filter((pattern) => !covers.includes(pattern)));
    expect(args.filter((_arg, index) => index !== args.indexOf("--disallowedTools") + 1)).toEqual(
      buildClaudeArgs("the prompt", "claude-x").filter((arg) => arg !== DENY_LIST),
    );
  });

  it("are refused when the session arguments carry no deny list flag", () => {
    withBuiltArguments(["-p", "the prompt", "--model", "claude-x"]);
    expect(() => controlArgs("the prompt", "claude-x", [])).toThrow(
      "no longer carries the deny list",
    );
  });

  it("are refused when the flag holds something other than the deny list", () => {
    withBuiltArguments(["-p", "the prompt", "--disallowedTools", "Bash(rm -fr*)"]);
    expect(() => controlArgs("the prompt", "claude-x", [])).toThrow(
      "no longer carries the deny list",
    );
  });
});

describe("the database guard hook as the control runs it", () => {
  const EDITED = [
    "if blocked; then",
    '  echo "first message" >&2',
    "  exit 2",
    "fi",
    "if other; then",
    '  echo "$command" >&2',
    "  exit 2",
    "fi",
    "exit 0",
    "",
  ].join("\n");

  it("goes back to exit 1 and standard output, and nothing else changes", () => {
    const unedited = uneditedHookText(EDITED);
    expect(unedited).toBe(
      [
        "if blocked; then",
        '  echo "first message"',
        "  exit 1",
        "fi",
        "if other; then",
        '  echo "$command"',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
  });

  it("is refused for a script that is not the edited one", () => {
    expect(() => uneditedHookText("exit 0\n")).toThrow("not 2 and at least 1");
    expect(() => uneditedHookText(EDITED.replace("exit 2", "exit 1"))).toThrow(
      "not 2 and at least 1",
    );
  });
});
