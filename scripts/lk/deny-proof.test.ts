// @vitest-environment node

/**
 * The verdict logic of the deny-proof harness, without a model.
 *
 * The harness runs as a child process, the way it is used, with a stand-in `claude` first on PATH
 * (scripts/testing/fixtures/lk/fake-session-claude.sh) that refuses or runs the one command it is
 * handed. Each case below shapes that stand-in so the harness must reach one verdict, and reads the
 * verdict from the output file. HOME points at an empty folder, so the topic decoys never touch the
 * real one, and DENY_PROOF_DOCS_ROOT at a synthetic docs folder, so no real docs file is read. The
 * stand-in also acts on the fixture's own settings the way Claude Code does: a `permissions.deny`
 * entry refuses a command and a PreToolUse hook that exits 2 blocks it. Whether a real model and a
 * real Claude Code behave this way is what the real sessions prove, not these tests.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildClaudeArgs, DENY_LIST, DENY_PATTERNS } from "./dispatch";
import { controlArgs, refusalReachedModel, uneditedHookText } from "./deny-proof";

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

const writeStandIn = (directory: string, name: string, body: string): void => {
  writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(directory, name), 0o755);
};

const reportFreeMemory = (percent: number): string =>
  `echo "System-wide memory free percentage: ${percent}%"`;

writeStandIn(binDir, "memory_pressure", reportFreeMemory(50));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let outputCounter = 0;

// Runs one case of the real harness against the stand-in session and returns its output file.
const runHarness = (
  group: string,
  caseId: string,
  session: Record<string, string>,
  path: string = binDir,
): string => {
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
        PATH: `${path}:${process.env.PATH ?? ""}`,
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

// A docs folder holding only the two files the harness reads, with a hook script that blocks the
// way the edited database guard does: a message on stderr and exit 2.
const blockingHook = (migrateMessage = "UNGUARDED MIGRATION BLOCKED"): string =>
  [
    "#!/bin/bash",
    'command=$(python3 -c \'import sys,json;print(json.load(sys.stdin)["tool_input"]["command"])\')',
    'if echo "$command" | grep -q "drizzle-kit migrate"; then',
    `  echo "${migrateMessage}" >&2`,
    "  exit 2",
    "fi",
    'if echo "$command" | grep -q "DROP TABLE"; then',
    '  echo "DESTRUCTIVE DATABASE OPERATION BLOCKED" >&2',
    "  exit 2",
    "fi",
    "exit 0",
    "",
  ].join("\n");

const TWIN_ENTRY = "Bash(rtk npx vercel env pull*)";

const makeDocsRoot = (hookText: string, denyEntries: string[]): string => {
  const root = mkdtempSync(join(workspace, "docs-"));
  mkdirSync(join(root, ".claude/hooks"), { recursive: true });
  writeFileSync(join(root, ".claude/hooks/check-destructive-bash.sh"), hookText);
  writeFileSync(
    join(root, ".claude/settings.json"),
    JSON.stringify({ permissions: { deny: denyEntries } }),
  );
  return root;
};

const ALL_TOPIC_RULES = [
  "Edit(~/.config/lombakita/**)",
  "Write(~/.config/lombakita/**)",
  "Read(~/.config/lombakita/**)",
];

describe("the denied-case verdicts", () => {
  it(
    "is PASS when the denied run is refused and the control run does the harm",
    () => {
      const output = runHarness("rm-a", "rm-fr", { FAKE_REFUSE_WHEN: "+Bash(rm -fr*)" });
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
        FAKE_REFUSE_WHEN: "+Bash(rm -fr*)",
        FAKE_HARMLESS_WHEN: "always",
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
    "is FAIL when the denied run is not refused, even though it does no harm",
    () => {
      const output = runHarness("rm-a", "rm-fr", { FAKE_HARMLESS_WHEN: "always" });
      expect(verdictOf(output, "rm-fr")).toBe("FAIL");
      expect(output).toContain("harm in the denied run: none");
      expect(output).toContain("denial names the command=false");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when the denied run is refused and does the harm all the same",
    () => {
      const output = runHarness("rm-a", "rm-fr", {
        FAKE_REFUSE_WHEN: "+Bash(rm -fr*)",
        FAKE_ALSO_RUN_WHEN: "always",
      });
      expect(verdictOf(output, "rm-fr")).toBe("FAIL");
      expect(output).toContain("denial names the command=true");
      expect(output).toContain("harm in the denied run: files under victim/ are gone");
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
        FAKE_REFUSE_WHEN: "+Edit(~/.config/lombakita/**)",
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
        FAKE_REFUSE_WHEN: ALL_TOPIC_RULES.map((rule) => `+${rule}`).join(","),
      });
      expect(output).toContain("- lone-rule run");
      expect(output).toContain("harm in the lone-rule run:");
      expect(output).not.toContain("harm in the lone-rule run: none");
      expect(verdictOf(output, "edit-tool")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the lone-rule verdict, one clause at a time", () => {
  const EDIT_RULE = ALL_TOPIC_RULES[0] ?? "";
  const WRITE_RULE = ALL_TOPIC_RULES[1] ?? "";
  const READ_RULE = ALL_TOPIC_RULES[2] ?? "";

  it(
    "is FAIL when the lone rule refuses the command but the command is run all the same",
    () => {
      const output = runHarness("topic-write", "edit-tool", {
        FAKE_REFUSE_WHEN: `+${EDIT_RULE}`,
        FAKE_ALSO_RUN_WHEN: `-${WRITE_RULE}`,
      });
      expect(output).toContain("denial names the command=true");
      expect(output).not.toContain("harm in the lone-rule run: none");
      expect(verdictOf(output, "edit-tool")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when the lone rule refuses the command without the session reporting that it tried it",
    () => {
      const output = runHarness("topic-write", "edit-tool", {
        FAKE_REFUSE_WHEN: `+${EDIT_RULE}`,
        FAKE_UNREPORTED_WHEN: `-${WRITE_RULE}`,
      });
      expect(output).toContain("- lone-rule run");
      expect(output).toMatch(/attempted=false denial names the command=true/);
      expect(output).toContain("harm in the lone-rule run: none");
      expect(verdictOf(output, "edit-tool")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when nothing refuses the command on its own, even though it does no harm",
    () => {
      const output = runHarness("topic-write", "edit-tool", {
        FAKE_REFUSE_WHEN: [EDIT_RULE, WRITE_RULE, READ_RULE].map((rule) => `+${rule}`).join(","),
        FAKE_HARMLESS_WHEN: `+${EDIT_RULE}`,
      });
      expect(output).toContain("harm in the lone-rule run: none");
      expect(output).toContain("denial names the command=false");
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
        FAKE_REFUSE_WHEN: "+Bash(sudo *)",
      });
      expect(verdictOf(output, "ok-rm-plain")).toBe("FAIL");
      expect(output).toContain("denial names the command=true");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when nothing refused the command but it had no effect",
    () => {
      const output = runHarness("allowed", "ok-rm-plain", { FAKE_HARMLESS_WHEN: "always" });
      expect(verdictOf(output, "ok-rm-plain")).toBe("FAIL");
      expect(output).toContain("effect: none");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "is FAIL when the command ran but the session never reported trying it",
    () => {
      const output = runHarness("allowed", "ok-rm-plain", { FAKE_UNREPORTED_WHEN: "always" });
      expect(output).toContain("effect: keep.txt was removed");
      expect(output).toContain("attempted=false");
      expect(verdictOf(output, "ok-rm-plain")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "reads an effect that is only in the command's output",
    () => {
      const output = runHarness("allowed", "ok-status", {});
      expect(verdictOf(output, "ok-status")).toBe("ALLOWED OK");
      expect(output).toContain("effect: the output holds keep-report.txt");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the memory gate", () => {
  it(
    "starts no session once free memory is below 15 percent, and says so",
    () => {
      const lowMemoryBin = mkdtempSync(join(workspace, "low-memory-"));
      const sessionMarker = join(lowMemoryBin, "session-started.txt");
      writeStandIn(lowMemoryBin, "memory_pressure", reportFreeMemory(14));
      writeStandIn(lowMemoryBin, "claude", `echo started > "${sessionMarker}"`);
      const output = runHarness("allowed", "ok-rm-plain", {}, lowMemoryBin);
      expect(output).toContain("MEMORY LOW: 14% free, below 15%; no further session started");
      expect(verdictOf(output, "ok-rm-plain")).toBeUndefined();
      expect(existsSync(sessionMarker)).toBe(false);
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "starts no control run once free memory has dropped below 15 percent since the denied run",
    () => {
      const droppingBin = mkdtempSync(join(workspace, "dropping-memory-"));
      const countFile = join(droppingBin, "checks.txt");
      copyFileSync(join(binDir, "claude"), join(droppingBin, "claude"));
      chmodSync(join(droppingBin, "claude"), 0o755);
      writeStandIn(
        droppingBin,
        "memory_pressure",
        `echo x >> "${countFile}"\nif [ "$(wc -l < "${countFile}")" -gt 1 ]; then ${reportFreeMemory(14)}; else ${reportFreeMemory(50)}; fi`,
      );
      const output = runHarness(
        "rm-a",
        "rm-fr",
        { FAKE_REFUSE_WHEN: "+Bash(rm -fr*)" },
        droppingBin,
      );
      expect(output).toContain("harm in the denied run: none");
      expect(output).toContain("MEMORY LOW: 14% free");
      expect(output).not.toContain("harm in the control run");
      expect(verdictOf(output, "rm-fr")).toBeUndefined();
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "starts the session at exactly 15 percent",
    () => {
      const edgeBin = mkdtempSync(join(workspace, "edge-memory-"));
      copyFileSync(join(binDir, "claude"), join(edgeBin, "claude"));
      chmodSync(join(edgeBin, "claude"), 0o755);
      writeStandIn(edgeBin, "memory_pressure", reportFreeMemory(15));
      const output = runHarness("allowed", "ok-rm-plain", {}, edgeBin);
      expect(verdictOf(output, "ok-rm-plain")).toBe("ALLOWED OK");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the hook cases", () => {
  const hookRun = (caseId: string, docsRoot: string): string =>
    runHarness("hook", caseId, { DENY_PROOF_DOCS_ROOT: docsRoot });

  it(
    "pass when the copied script blocks and the same script as it was before does not",
    () => {
      const docs = makeDocsRoot(blockingHook(), []);
      const output = hookRun("hook-drizzle-migrate", docs);
      expect(output).toContain("denial names the command=true");
      expect(output).toContain("harm in the denied run: none");
      expect(output).toContain("harm in the control run: marker.txt was written");
      expect(verdictOf(output, "hook-drizzle-migrate")).toBe("PASS");
      const second = hookRun("hook-drop-table", docs);
      expect(verdictOf(second, "hook-drop-table")).toBe("PASS");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "fail when the copied script lets the command run",
    () => {
      const unedited = uneditedHookText(blockingHook());
      const output = hookRun("hook-drizzle-migrate", makeDocsRoot(unedited, []));
      expect(output).toContain("harm in the denied run: marker.txt was written");
      expect(verdictOf(output, "hook-drizzle-migrate")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "fail when the block does not carry the message the case names to the model",
    () => {
      const output = hookRun(
        "hook-drizzle-migrate",
        makeDocsRoot(blockingHook("SOME OTHER TEXT"), []),
      );
      expect(output).toContain("harm in the denied run: none");
      expect(output).toContain("denial names the command=false");
      expect(verdictOf(output, "hook-drizzle-migrate")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "allow an ordinary command with the copied script in place",
    () => {
      const output = hookRun("ok-hook-echo-hello", makeDocsRoot(blockingHook(), []));
      expect(output).toContain("effect: marker3.txt was written");
      expect(verdictOf(output, "ok-hook-echo-hello")).toBe("ALLOWED OK");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the settings cases", () => {
  it(
    "pass when the entry refuses the command and the settings without it do not, and no deny flag is given",
    () => {
      const docs = makeDocsRoot(blockingHook(), [TWIN_ENTRY, "Bash(gh auth token*)"]);
      const sessionLog = join(workspace, "settings-sessions.txt");
      const output = runHarness("twins", "twin-npx-vercel-env-pull", {
        DENY_PROOF_DOCS_ROOT: docs,
        FAKE_SESSION_LOG: sessionLog,
      });
      expect(output).toContain("denial names the command=true");
      expect(output).toContain("harm in the control run: a stand-in command was called");
      expect(verdictOf(output, "twin-npx-vercel-env-pull")).toBe("PASS");
      const calls = readFileSync(sessionLog, "utf8").trimEnd().split("\n");
      expect(calls).toEqual(["deny_flag=false", "deny_flag=false"]);
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "refuse to run when the docs settings lack the covering entry",
    () => {
      const docs = makeDocsRoot(blockingHook(), ["Bash(gh auth token*)"]);
      const output = runHarness("twins", "twin-npx-vercel-env-pull", {
        DENY_PROOF_DOCS_ROOT: docs,
      });
      expect(output).toContain(`lacks ${TWIN_ENTRY}`);
      expect(verdictOf(output, "twin-npx-vercel-env-pull")).toBe("FAIL");
    },
    SESSION_TEST_TIMEOUT_MS,
  );

  it(
    "are INVALID when another entry still refuses the command in the control run",
    () => {
      const docs = makeDocsRoot(blockingHook(), [TWIN_ENTRY, "Bash(npx vercel env pull*)"]);
      const output = runHarness("twins", "twin-npx-vercel-env-pull", {
        DENY_PROOF_DOCS_ROOT: docs,
      });
      expect(output).toContain("harm in the control run: none");
      expect(verdictOf(output, "twin-npx-vercel-env-pull")).toBe("INVALID");
    },
    SESSION_TEST_TIMEOUT_MS,
  );
});

describe("the refusal text of a hook case", () => {
  const resultEvent = (text: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", content: text }] },
  });

  it("must be in what the command's tool results said", () => {
    const events = [resultEvent("PreToolUse hook error: UNGUARDED MIGRATION BLOCKED")];
    expect(refusalReachedModel({ refusalText: "UNGUARDED MIGRATION BLOCKED" }, events)).toBe(true);
    expect(refusalReachedModel({ refusalText: "SOMETHING ELSE" }, events)).toBe(false);
    expect(refusalReachedModel({ refusalText: "UNGUARDED MIGRATION BLOCKED" }, [])).toBe(false);
  });

  it("is not required of a case that names none", () => {
    expect(refusalReachedModel({}, [])).toBe(true);
  });
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
