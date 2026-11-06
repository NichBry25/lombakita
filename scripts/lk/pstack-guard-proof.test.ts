// @vitest-environment node

/**
 * The pstack guard proof, in process with injected sessions and as a stand-in process.
 *
 * No test starts `claude`: the cases of runCase and main hand it a scripted session, the cases of
 * runClaudeSession start a shell script that the test writes into a scratch folder, and the process
 * tests run the real script with such a shell script first on PATH. The session log lines below are
 * trimmed real lines of session logs, used as literal strings.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LkRefusal } from "./models";
import {
  PROOF_CASES,
  buildFixtureSettings,
  buildSessionArguments,
  exitCodeOf,
  findCallResult,
  findModelCall,
  fixtureFolders,
  foreignToolNames,
  formatCase,
  formatFinalLine,
  homeFileProblems,
  installSignalHandlers,
  judgeControlRun,
  judgeDeniedRun,
  main,
  makeFixture,
  parseSessionLog,
  readDocsEntries,
  removeFixtureFolder,
  runCase,
  runClaudeSession,
  runningSessionPids,
  snapshotHomeFiles,
  terminateAfterSignal,
  verdictOf,
} from "./pstack-guard-proof";

type ProofCase = (typeof PROOF_CASES)[number];
type SessionEvent = ReturnType<typeof parseSessionLog>[number];
type RunSession = Parameters<typeof runCase>[1];
type CaseSessionRequest = Parameters<RunSession>[0];
type SessionResult = Awaited<ReturnType<RunSession>>;
type CaseReport = Awaited<ReturnType<typeof runCase>>;
type MainDeps = Parameters<typeof main>[1];
type SignalDeps = Parameters<typeof terminateAfterSignal>[2];
type DeniedJudgment = Parameters<typeof verdictOf>[0];
type ControlJudgment = NonNullable<Parameters<typeof verdictOf>[1]>;

// ---------------------------------------------------------------------------------------------
// Session log lines, trimmed from real sessions
// ---------------------------------------------------------------------------------------------

const AGENT_CALL =
  '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_018WnViM7321iNWfRPEAmB8C","name":"Agent","input":{"description":"Reply ok","subagent_type":"pstack:poteto-agent","prompt":"Reply with the single word ok and do nothing else."},"caller":{"type":"direct"}}]},"parent_tool_use_id":null}';
const AGENT_CALL_REFUSED_RESULT =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Agent type \'pstack:poteto-agent\' has been denied by permission rule \'Agent(pstack:poteto-agent)\' from projectSettings.","is_error":true,"tool_use_id":"toolu_018WnViM7321iNWfRPEAmB8C"}]},"parent_tool_use_id":null}';
const AGENT_CALL_ALLOWED_RESULT =
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01WcyZZBk7g87ySx61FJwW24","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},"parent_tool_use_id":null}';
const SKILL_CALL_ALLOWED_RESULT =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01HhBqnkas5ef9fxRzUCec84","content":"Launching skill: pstack:setup-pstack"}]},"parent_tool_use_id":null}';
const SKILL_REFUSAL_SYSTEM_EVENT =
  '{"type":"system","subtype":"permission_denied","tool_name":"Skill","tool_use_id":"toolu_014h4mFvRC7k6vyc5rkpWa4e","decision_reason_type":"rule","message":"Skill execution blocked by permission rules"}';
const SKILL_CALL =
  '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_014h4mFvRC7k6vyc5rkpWa4e","name":"Skill","input":{"skill":"pstack:setup-pstack"},"caller":{"type":"direct"}}]},"parent_tool_use_id":null}';
const SKILL_CALL_REFUSED_RESULT =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Skill execution blocked by permission rules","is_error":true,"tool_use_id":"toolu_014h4mFvRC7k6vyc5rkpWa4e"}]},"parent_tool_use_id":null}';

const AGENT_CALL_ID = "toolu_018WnViM7321iNWfRPEAmB8C";
const AGENT_CALL_ALLOWED_RESULT_ID = "toolu_01WcyZZBk7g87ySx61FJwW24";
const SKILL_CALL_ALLOWED_RESULT_ID = "toolu_01HhBqnkas5ef9fxRzUCec84";
const SKILL_CALL_ID = "toolu_014h4mFvRC7k6vyc5rkpWa4e";

// The allowed results answer calls that the Agent call and the Skill call above do not make, so
// each takes the id of the call it is paired with in a control run.
const AGENT_CALL_ALLOWED_RESULT_FOR_CALL = AGENT_CALL_ALLOWED_RESULT.replace(
  AGENT_CALL_ALLOWED_RESULT_ID,
  AGENT_CALL_ID,
);
const SKILL_CALL_ALLOWED_RESULT_FOR_CALL = SKILL_CALL_ALLOWED_RESULT.replace(
  SKILL_CALL_ALLOWED_RESULT_ID,
  SKILL_CALL_ID,
);
const AGENT_CALL_FROM_STARTED_AGENT = AGENT_CALL.replace(
  '"parent_tool_use_id":null',
  '"parent_tool_use_id":"toolu_01StartedAgent"',
);

const READ_CALL =
  '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01ReadCall","name":"Read","input":{"file_path":"notes.txt"}}]},"parent_tool_use_id":null}';
const GLOB_CALL =
  '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01GlobCall","name":"Glob","input":{"pattern":"*.md"}}]},"parent_tool_use_id":null}';
const READ_CALL_FROM_STARTED_AGENT = READ_CALL.replace(
  '"parent_tool_use_id":null',
  '"parent_tool_use_id":"toolu_01StartedAgent"',
);

const logOf = (...lines: string[]): string => `${lines.join("\n")}\n`;

const DENIED_AGENT_LOG = logOf(AGENT_CALL, AGENT_CALL_REFUSED_RESULT);
const ALLOWED_AGENT_LOG = logOf(AGENT_CALL, AGENT_CALL_ALLOWED_RESULT_FOR_CALL);
const DENIED_SKILL_LOG = logOf(SKILL_CALL, SKILL_REFUSAL_SYSTEM_EVENT, SKILL_CALL_REFUSED_RESULT);
const ALLOWED_SKILL_LOG = logOf(SKILL_CALL, SKILL_CALL_ALLOWED_RESULT_FOR_CALL);
const NO_CALL_LOG = logOf('{"type":"result","subtype":"success"}');

const caseById = (id: string): ProofCase => {
  const found = PROOF_CASES.find((testCase) => testCase.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

const AGENT_CASE = caseById("agent-poteto");
const SKILL_CASE = caseById("skill-setup");
const AGENT_ENTRY = "Agent(pstack:poteto-agent)";
const SKILL_ENTRY = "Skill(pstack:setup-pstack)";

const loggedSession = (log: string, timedOut = false): SessionResult => ({ timedOut, log });
const TIMED_OUT_SESSION = loggedSession("", true);

const logFor = (caseId: string, kind: "denied" | "allowed"): string => {
  if (caseId === "agent-poteto") return kind === "denied" ? DENIED_AGENT_LOG : ALLOWED_AGENT_LOG;
  if (caseId === "skill-setup") return kind === "denied" ? DENIED_SKILL_LOG : ALLOWED_SKILL_LOG;
  throw new Error(`no log for case ${caseId}`);
};

const passingSession: RunSession = async (request) =>
  loggedSession(logFor(request.caseId, request.run === "control" ? "allowed" : "denied"));

// ---------------------------------------------------------------------------------------------
// Scratch folders
// ---------------------------------------------------------------------------------------------

const withScratchFolder = async <T>(body: (folder: string) => T | Promise<T>): Promise<T> => {
  const folder = mkdtempSync(join(tmpdir(), "lk-pgp-test-"));
  try {
    return await body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const removeAllFixtures = (): void => {
  for (const folder of fixtureFolders()) removeFixtureFolder(folder);
};

// The base folder is made before TMPDIR moves, so every fixture of the body lands under `tmp`.
const withTemporaryTmpdir = async (
  body: (base: string, tmp: string) => void | Promise<void>,
): Promise<void> => {
  const original = process.env.TMPDIR;
  const base = mkdtempSync(join(tmpdir(), "lk-pgp-test-"));
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  try {
    await body(base, tmp);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    rmSync(base, { recursive: true, force: true });
  }
};

const refusalMessageOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LkRefusal);
    return (error as Error).message;
  }
  throw new Error("expected the call to refuse");
};

const settingsTextWith = (entries: unknown): string =>
  JSON.stringify({ permissions: { deny: entries } });

const writeDocsSettings = (docsRoot: string, text: string): void => {
  mkdirSync(join(docsRoot, ".claude"), { recursive: true });
  writeFileSync(join(docsRoot, ".claude/settings.json"), text);
};

// ---------------------------------------------------------------------------------------------
// The case table and the pure builders
// ---------------------------------------------------------------------------------------------

describe("PROOF_CASES", () => {
  it("holds the two cases, in order, field by field", () => {
    expect(PROOF_CASES).toEqual([
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
    ]);
  });
});

describe("buildFixtureSettings", () => {
  it("holds the entry in the deny array for an entry", () => {
    expect(buildFixtureSettings("Agent(pstack:poteto-agent)")).toBe(
      '{"permissions":{"deny":["Agent(pstack:poteto-agent)"]}}\n',
    );
  });

  it("holds an empty deny array for undefined", () => {
    expect(buildFixtureSettings(undefined)).toBe('{"permissions":{"deny":[]}}\n');
  });
});

describe("buildSessionArguments", () => {
  it("returns the exact vector, so a dropped, changed or moved flag fails", () => {
    expect(buildSessionArguments("the prompt", "claude-test-light")).toEqual([
      "-p",
      "the prompt",
      "--model",
      "claude-test-light",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      "Agent,Skill",
      "--strict-mcp-config",
      "--disallowedTools",
      "Write,Edit,MultiEdit,NotebookEdit,Bash",
      "--max-turns",
      "6",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading a session log
// ---------------------------------------------------------------------------------------------

describe("parseSessionLog", () => {
  it("skips a line that is not JSON, skips the system event whose message is a string and keeps the call and result lines", () => {
    const text = logOf(
      "a plain line from the tool",
      AGENT_CALL,
      "{ this starts like an event but is not JSON",
      AGENT_CALL_REFUSED_RESULT,
      AGENT_CALL_ALLOWED_RESULT,
      SKILL_CALL_ALLOWED_RESULT,
      SKILL_REFUSAL_SYSTEM_EVENT,
      "[1,2,3]",
      SKILL_CALL,
      SKILL_CALL_REFUSED_RESULT,
    );

    const events = parseSessionLog(text);

    expect(events).toEqual(
      [
        AGENT_CALL,
        AGENT_CALL_REFUSED_RESULT,
        AGENT_CALL_ALLOWED_RESULT,
        SKILL_CALL_ALLOWED_RESULT,
        SKILL_CALL,
        SKILL_CALL_REFUSED_RESULT,
      ].map((line) => JSON.parse(line)),
    );
  });

  it("keeps an event that carries no message", () => {
    const events = parseSessionLog(NO_CALL_LOG);

    expect(events).toEqual([{ type: "result", subtype: "success" }]);
  });

  it("returns no events for an empty log", () => {
    expect(parseSessionLog("")).toEqual([]);
  });
});

describe("findModelCall", () => {
  it("finds AGENT_CALL for the agent case", () => {
    const call = findModelCall(parseSessionLog(logOf(AGENT_CALL)), AGENT_CASE);

    expect(call?.id).toBe(AGENT_CALL_ID);
  });

  it("finds SKILL_CALL for the skill case", () => {
    const call = findModelCall(parseSessionLog(logOf(SKILL_CALL)), SKILL_CASE);

    expect(call?.id).toBe(SKILL_CALL_ID);
  });

  it("ignores AGENT_CALL with a non-null parent_tool_use_id", () => {
    const events = parseSessionLog(logOf(AGENT_CALL_FROM_STARTED_AGENT));

    expect(findModelCall(events, AGENT_CASE)).toBeUndefined();
  });

  it("ignores a call of another tool name", () => {
    const renamed = AGENT_CALL.replace('"name":"Agent"', '"name":"Task"');

    expect(findModelCall(parseSessionLog(logOf(renamed)), AGENT_CASE)).toBeUndefined();
    expect(findModelCall(parseSessionLog(logOf(AGENT_CALL)), SKILL_CASE)).toBeUndefined();
    expect(findModelCall(parseSessionLog(logOf(SKILL_CALL)), AGENT_CASE)).toBeUndefined();
  });

  it("ignores a call with the bare name poteto-agent", () => {
    const bare = AGENT_CALL.replace(
      '"subagent_type":"pstack:poteto-agent"',
      '"subagent_type":"poteto-agent"',
    );

    expect(findModelCall(parseSessionLog(logOf(bare)), AGENT_CASE)).toBeUndefined();
  });

  it("ignores a call whose target field is missing", () => {
    const noTarget = SKILL_CALL.replace(
      '"skill":"pstack:setup-pstack"',
      '"other":"pstack:setup-pstack"',
    );

    expect(findModelCall(parseSessionLog(logOf(noTarget)), SKILL_CASE)).toBeUndefined();
  });

  it("ignores an event whose message is a string, without throwing", () => {
    const stringMessage: SessionEvent[] = [
      { type: "assistant", message: "a string", parent_tool_use_id: null },
      JSON.parse(SKILL_REFUSAL_SYSTEM_EVENT),
    ];

    expect(findModelCall(stringMessage, SKILL_CASE)).toBeUndefined();
  });

  it("takes the first of two matching calls", () => {
    const second = AGENT_CALL.replace(AGENT_CALL_ID, "toolu_0SecondCall");
    const events = parseSessionLog(logOf(AGENT_CALL, second));

    expect(findModelCall(events, AGENT_CASE)?.id).toBe(AGENT_CALL_ID);
  });
});

describe("foreignToolNames", () => {
  it("returns no name when every tool use is an Agent or a Skill call", () => {
    const events = parseSessionLog(logOf(AGENT_CALL, SKILL_CALL, AGENT_CALL_REFUSED_RESULT));

    expect(foreignToolNames(events)).toEqual([]);
  });

  it("returns no name for an empty log", () => {
    expect(foreignToolNames([])).toEqual([]);
  });

  it("counts a Read call in an event with a non-null parent_tool_use_id", () => {
    const events = parseSessionLog(logOf(AGENT_CALL, READ_CALL_FROM_STARTED_AGENT));

    expect(foreignToolNames(events)).toEqual(["Read"]);
  });

  it("returns a name that appears twice once", () => {
    const events = parseSessionLog(logOf(READ_CALL, READ_CALL_FROM_STARTED_AGENT, READ_CALL));

    expect(foreignToolNames(events)).toEqual(["Read"]);
  });

  it("returns two names in the order they were first seen", () => {
    const events = parseSessionLog(logOf(GLOB_CALL, AGENT_CALL, READ_CALL, GLOB_CALL));

    expect(foreignToolNames(events)).toEqual(["Glob", "Read"]);
  });

  it("ignores a tool use that sits in an event that is not from the assistant", () => {
    const inUserEvent = READ_CALL.replace('"type":"assistant"', '"type":"user"');

    expect(foreignToolNames(parseSessionLog(logOf(inUserEvent)))).toEqual([]);
  });
});

describe("findCallResult", () => {
  it("finds AGENT_CALL_REFUSED_RESULT, a refusal with string content", () => {
    const result = findCallResult(parseSessionLog(logOf(AGENT_CALL_REFUSED_RESULT)), AGENT_CALL_ID);

    expect(result).toEqual({
      isError: true,
      text: "Agent type 'pstack:poteto-agent' has been denied by permission rule 'Agent(pstack:poteto-agent)' from projectSettings.",
    });
  });

  it("finds AGENT_CALL_ALLOWED_RESULT, an allowed call with array content", () => {
    const result = findCallResult(
      parseSessionLog(logOf(AGENT_CALL_ALLOWED_RESULT)),
      AGENT_CALL_ALLOWED_RESULT_ID,
    );

    expect(result).toEqual({ isError: false, text: "Async agent launched successfully." });
  });

  it("finds SKILL_CALL_ALLOWED_RESULT, an allowed call with string content", () => {
    const result = findCallResult(
      parseSessionLog(logOf(SKILL_CALL_ALLOWED_RESULT)),
      SKILL_CALL_ALLOWED_RESULT_ID,
    );

    expect(result).toEqual({ isError: false, text: "Launching skill: pstack:setup-pstack" });
  });

  it("finds SKILL_CALL_REFUSED_RESULT, a refusal of the skill call", () => {
    const result = findCallResult(parseSessionLog(logOf(SKILL_CALL_REFUSED_RESULT)), SKILL_CALL_ID);

    expect(result).toEqual({ isError: true, text: "Skill execution blocked by permission rules" });
  });

  it("ignores a result of another id", () => {
    const events = parseSessionLog(
      logOf(
        AGENT_CALL_REFUSED_RESULT,
        AGENT_CALL_ALLOWED_RESULT,
        SKILL_CALL_ALLOWED_RESULT,
        SKILL_CALL_REFUSED_RESULT,
      ),
    );

    expect(findCallResult(events, "toolu_other")).toBeUndefined();
  });

  it("joins the text blocks of array content with a newline and skips other blocks", () => {
    const event: SessionEvent = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: AGENT_CALL_ID,
            content: [
              { type: "text", text: "first" },
              { type: "image", source: "ignored" },
              { type: "text", text: "second" },
            ],
          },
        ],
      },
      parent_tool_use_id: null,
    };

    expect(findCallResult([event], AGENT_CALL_ID)).toEqual({
      isError: false,
      text: "first\nsecond",
    });
  });

  it("reports is_error absent as not an error and counts only the value true", () => {
    const withValue = (isError: unknown): SessionEvent => ({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: AGENT_CALL_ID, content: "x", is_error: isError },
        ],
      },
      parent_tool_use_id: null,
    });

    expect(
      findCallResult(parseSessionLog(logOf(SKILL_CALL_ALLOWED_RESULT_FOR_CALL)), SKILL_CALL_ID)
        ?.isError,
    ).toBe(false);
    expect(findCallResult([withValue("true")], AGENT_CALL_ID)?.isError).toBe(false);
    expect(findCallResult([withValue(true)], AGENT_CALL_ID)?.isError).toBe(true);
  });

  it("ignores a result that sits in a started agent's event", () => {
    const fromAgent = AGENT_CALL_REFUSED_RESULT.replace(
      '"parent_tool_use_id":null',
      '"parent_tool_use_id":"toolu_01StartedAgent"',
    );

    expect(findCallResult(parseSessionLog(logOf(fromAgent)), AGENT_CALL_ID)).toBeUndefined();
  });

  it("ignores an event whose message is a string, without throwing", () => {
    const stringMessage: SessionEvent[] = [
      { type: "user", message: "a string", parent_tool_use_id: null },
    ];

    expect(findCallResult(stringMessage, AGENT_CALL_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The judgments and the verdict
// ---------------------------------------------------------------------------------------------

const callEventFor = (testCase: ProofCase): SessionEvent =>
  JSON.parse(testCase.tool === "Agent" ? AGENT_CALL : SKILL_CALL);

const callIdFor = (testCase: ProofCase): string =>
  testCase.tool === "Agent" ? AGENT_CALL_ID : SKILL_CALL_ID;

const resultEventFor = (toolUseId: string, isError: boolean, text: string): SessionEvent => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: text,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
  parent_tool_use_id: null,
});

interface Combination {
  attempted: boolean;
  resultExists: boolean;
  isError: boolean;
  refusalTextPresent: boolean;
  timedOut: boolean;
}

const COMBINATIONS: Combination[] = [false, true].flatMap((attempted) =>
  [false, true].flatMap((resultExists) =>
    [false, true].flatMap((isError) =>
      [false, true].flatMap((refusalTextPresent) =>
        [false, true].map((timedOut) => ({
          attempted,
          resultExists,
          isError,
          refusalTextPresent,
          timedOut,
        })),
      ),
    ),
  ),
);

const eventsForCombination = (testCase: ProofCase, combination: Combination): SessionEvent[] => {
  const text = combination.refusalTextPresent
    ? `It said: ${testCase.refusalText}.`
    : "some other text";
  const events: SessionEvent[] = [];
  if (combination.attempted) events.push(callEventFor(testCase));
  if (combination.resultExists) {
    events.push(resultEventFor(callIdFor(testCase), combination.isError, text));
  }
  return events;
};

interface LiteralDeniedRow {
  name: string;
  combination: Combination;
  expected: DeniedJudgment;
}

interface LiteralControlRow {
  name: string;
  combination: Combination;
  expected: ControlJudgment;
}

const LITERAL_DENIED_ROWS: LiteralDeniedRow[] = [
  {
    name: "refusal text present with isError false",
    combination: {
      attempted: true,
      resultExists: true,
      isError: false,
      refusalTextPresent: true,
      timedOut: false,
    },
    expected: { attempted: true, refused: false, timedOut: false },
  },
  {
    name: "isError true with the refusal text absent",
    combination: {
      attempted: true,
      resultExists: true,
      isError: true,
      refusalTextPresent: false,
      timedOut: false,
    },
    expected: { attempted: true, refused: false, timedOut: false },
  },
];

const LITERAL_CONTROL_ROWS: LiteralControlRow[] = [
  {
    name: "isError true",
    combination: {
      attempted: true,
      resultExists: true,
      isError: true,
      refusalTextPresent: true,
      timedOut: false,
    },
    expected: { attempted: true, allowed: false, timedOut: false },
  },
];

describe("judgeDeniedRun", () => {
  it.each(PROOF_CASES.map((testCase) => [testCase.id, testCase] as const))(
    "returns the judgment of every combination for %s",
    (_id, testCase) => {
      expect(COMBINATIONS).toHaveLength(32);
      for (const combination of COMBINATIONS) {
        const events = eventsForCombination(testCase, combination);

        const judgment = judgeDeniedRun(events, testCase, combination.timedOut);

        expect(judgment, JSON.stringify(combination)).toEqual({
          attempted: combination.attempted,
          refused:
            !combination.timedOut &&
            combination.attempted &&
            combination.resultExists &&
            combination.isError &&
            combination.refusalTextPresent,
          timedOut: combination.timedOut,
        });
      }
    },
  );

  it.each(
    PROOF_CASES.flatMap((testCase) =>
      LITERAL_DENIED_ROWS.map((row) => [testCase.id, row.name, testCase, row] as const),
    ),
  )("returns the written-out judgment for %s with %s", (_id, _name, testCase, row) => {
    const events = eventsForCombination(testCase, row.combination);

    expect(judgeDeniedRun(events, testCase, row.combination.timedOut)).toEqual(row.expected);
  });

  it("reads the real refusals of the Agent call and the Skill call as refused", () => {
    expect(judgeDeniedRun(parseSessionLog(DENIED_AGENT_LOG), AGENT_CASE, false)).toEqual({
      attempted: true,
      refused: true,
      timedOut: false,
    });
    expect(judgeDeniedRun(parseSessionLog(DENIED_SKILL_LOG), SKILL_CASE, false)).toEqual({
      attempted: true,
      refused: true,
      timedOut: false,
    });
  });

  it("reads the real allowed results of the Agent call and the Skill call as not refused", () => {
    expect(judgeDeniedRun(parseSessionLog(ALLOWED_AGENT_LOG), AGENT_CASE, false).refused).toBe(
      false,
    );
    expect(judgeDeniedRun(parseSessionLog(ALLOWED_SKILL_LOG), SKILL_CASE, false).refused).toBe(
      false,
    );
  });

  it("does not take the refusal text of the other case", () => {
    const events = [
      callEventFor(SKILL_CASE),
      resultEventFor(SKILL_CALL_ID, true, AGENT_CASE.refusalText),
    ];

    expect(judgeDeniedRun(events, SKILL_CASE, false).refused).toBe(false);
  });
});

describe("judgeControlRun", () => {
  it.each(PROOF_CASES.map((testCase) => [testCase.id, testCase] as const))(
    "returns the judgment of every combination for %s",
    (_id, testCase) => {
      for (const combination of COMBINATIONS) {
        const events = eventsForCombination(testCase, combination);

        const judgment = judgeControlRun(events, testCase, combination.timedOut);

        expect(judgment, JSON.stringify(combination)).toEqual({
          attempted: combination.attempted,
          allowed:
            !combination.timedOut &&
            combination.attempted &&
            combination.resultExists &&
            !combination.isError,
          timedOut: combination.timedOut,
        });
      }
    },
  );

  it.each(
    PROOF_CASES.flatMap((testCase) =>
      LITERAL_CONTROL_ROWS.map((row) => [testCase.id, row.name, testCase, row] as const),
    ),
  )("returns the written-out judgment for %s with %s", (_id, _name, testCase, row) => {
    const events = eventsForCombination(testCase, row.combination);

    expect(judgeControlRun(events, testCase, row.combination.timedOut)).toEqual(row.expected);
  });

  it("reads the real allowed results of the Agent call and the Skill call as allowed", () => {
    expect(judgeControlRun(parseSessionLog(ALLOWED_AGENT_LOG), AGENT_CASE, false)).toEqual({
      attempted: true,
      allowed: true,
      timedOut: false,
    });
    expect(judgeControlRun(parseSessionLog(ALLOWED_SKILL_LOG), SKILL_CASE, false)).toEqual({
      attempted: true,
      allowed: true,
      timedOut: false,
    });
  });

  it("reads the real refusals of the Agent call and the Skill call as not allowed", () => {
    expect(judgeControlRun(parseSessionLog(DENIED_AGENT_LOG), AGENT_CASE, false).allowed).toBe(
      false,
    );
    expect(judgeControlRun(parseSessionLog(DENIED_SKILL_LOG), SKILL_CASE, false).allowed).toBe(
      false,
    );
  });
});

describe("verdictOf", () => {
  const refusedDenial: DeniedJudgment = { attempted: true, refused: true, timedOut: false };
  const allowedControl: ControlJudgment = { attempted: true, allowed: true, timedOut: false };

  it("is FAIL when the denied run timed out, before anything else", () => {
    const denied = { attempted: false, refused: false, timedOut: true };

    expect(verdictOf(denied, undefined)).toBe("FAIL");
    expect(verdictOf({ ...refusedDenial, timedOut: true }, allowedControl)).toBe("FAIL");
  });

  it("is NOT ATTEMPTED when the model made no call", () => {
    const denied = { attempted: false, refused: false, timedOut: false };

    expect(verdictOf(denied, undefined)).toBe("NOT ATTEMPTED");
    expect(verdictOf(denied, allowedControl)).toBe("NOT ATTEMPTED");
  });

  it("is FAIL when the call was made and not refused", () => {
    const denied = { attempted: true, refused: false, timedOut: false };

    expect(verdictOf(denied, undefined)).toBe("FAIL");
    expect(verdictOf(denied, { attempted: false, allowed: false, timedOut: true })).toBe("FAIL");
  });

  it("is INVALID when the control is undefined", () => {
    expect(verdictOf(refusedDenial, undefined)).toBe("INVALID");
  });

  it("is INVALID when the control timed out", () => {
    expect(verdictOf(refusedDenial, { ...allowedControl, timedOut: true })).toBe("INVALID");
  });

  it("is INVALID when the control made no call", () => {
    expect(verdictOf(refusedDenial, { ...allowedControl, attempted: false })).toBe("INVALID");
  });

  it("is INVALID when the control was not allowed", () => {
    expect(verdictOf(refusedDenial, { ...allowedControl, allowed: false })).toBe("INVALID");
  });

  it("is PASS when the denied call was refused and the control was allowed", () => {
    expect(verdictOf(refusedDenial, allowedControl)).toBe("PASS");
    expect(verdictOf(refusedDenial, allowedControl, { denied: [], control: [] })).toBe("PASS");
  });

  it("is FAIL when the denied run holds a foreign tool use, ahead of NOT ATTEMPTED", () => {
    const noCall = { attempted: false, refused: false, timedOut: false };
    const foreign = { denied: ["Read"], control: [] };

    expect(verdictOf(noCall, undefined, foreign)).toBe("FAIL");
    expect(verdictOf(refusedDenial, allowedControl, foreign)).toBe("FAIL");
  });

  it("is FAIL when the control run holds a foreign tool use, ahead of INVALID", () => {
    const foreign = { denied: [], control: ["Read"] };

    expect(verdictOf(refusedDenial, allowedControl, foreign)).toBe("FAIL");
    expect(verdictOf(refusedDenial, { ...allowedControl, allowed: false }, foreign)).toBe("FAIL");
    expect(verdictOf(refusedDenial, undefined, foreign)).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------------------------
// runCase with a scripted session
// ---------------------------------------------------------------------------------------------

type Scripted = SessionResult | Error;

const scriptedSessions = (script: Scripted[]) => {
  const requests: CaseSessionRequest[] = [];
  const runSession: RunSession = async (request) => {
    requests.push(request);
    const next = script[requests.length - 1];
    if (next === undefined) throw new Error("unscripted session");
    if (next instanceof Error) throw next;
    return next;
  };
  return { runSession, requests };
};

const deniedRequest = (run: "denied" | "denied-retry"): CaseSessionRequest => ({
  caseId: "agent-poteto",
  run,
  entry: "Agent(pstack:poteto-agent)",
  prompt: AGENT_CASE.prompt,
});

const CONTROL_REQUEST: CaseSessionRequest = {
  caseId: "agent-poteto",
  run: "control",
  entry: undefined,
  prompt: AGENT_CASE.prompt,
};

const REFUSED_DENIAL: DeniedJudgment = { attempted: true, refused: true, timedOut: false };
const ALLOWED_CONTROL: ControlJudgment = { attempted: true, allowed: true, timedOut: false };

describe("runCase", () => {
  it("passes: the denied run, then the control run", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(ALLOWED_AGENT_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: false,
      denied: REFUSED_DENIAL,
      deniedForeign: [],
      control: ALLOWED_CONTROL,
      controlForeign: [],
      error: undefined,
      verdict: "PASS",
    });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });

  it("passes the skill case through the same two runs", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_SKILL_LOG),
      loggedSession(ALLOWED_SKILL_LOG),
    ]);

    const report = await runCase(SKILL_CASE, runSession);

    expect(report.verdict).toBe("PASS");
    expect(requests.map((request) => [request.caseId, request.run, request.entry])).toEqual([
      ["skill-setup", "denied", "Skill(pstack:setup-pstack)"],
      ["skill-setup", "control", undefined],
    ]);
  });

  it("fails when the denied call was not refused, and starts no control run", async () => {
    const { runSession, requests } = scriptedSessions([loggedSession(ALLOWED_AGENT_LOG)]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.denied).toEqual({ attempted: true, refused: false, timedOut: false });
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("fails when the denied call was refused with other text", async () => {
    const otherRefusal = AGENT_CALL_REFUSED_RESULT.replace(
      "has been denied by permission rule",
      "was stopped by",
    );
    const { runSession, requests } = scriptedSessions([
      loggedSession(logOf(AGENT_CALL, otherRefusal)),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.denied?.refused).toBe(false);
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("is NOT ATTEMPTED after two denied runs without a call, and starts no control run", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      loggedSession(NO_CALL_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: true,
      denied: { attempted: false, refused: false, timedOut: false },
      deniedForeign: [],
      control: undefined,
      controlForeign: [],
      error: undefined,
      verdict: "NOT ATTEMPTED",
    });
    expect(requests).toEqual([deniedRequest("denied"), deniedRequest("denied-retry")]);
  });

  it("passes when the retry is refused and the control run is allowed", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(ALLOWED_AGENT_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("PASS");
    expect(report.retried).toBe(true);
    expect(report.denied).toEqual(REFUSED_DENIAL);
    expect(report.control).toEqual(ALLOWED_CONTROL);
    expect(requests).toEqual([
      deniedRequest("denied"),
      deniedRequest("denied-retry"),
      CONTROL_REQUEST,
    ]);
  });

  it("fails when the retry attempted the call and it was not refused", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      loggedSession(ALLOWED_AGENT_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.retried).toBe(true);
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied"), deniedRequest("denied-retry")]);
  });

  it("fails when the denied run timed out, with no retry", async () => {
    const { runSession, requests } = scriptedSessions([TIMED_OUT_SESSION]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.retried).toBe(false);
    expect(report.denied).toEqual({ attempted: false, refused: false, timedOut: true });
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("fails when the retry timed out", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      TIMED_OUT_SESSION,
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.retried).toBe(true);
    expect(report.denied?.timedOut).toBe(true);
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied"), deniedRequest("denied-retry")]);
  });

  it("is INVALID when the control run timed out", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(ALLOWED_AGENT_LOG, true),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("INVALID");
    expect(report.control).toEqual({ attempted: true, allowed: false, timedOut: true });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });

  it("is INVALID when the control run made no call", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(NO_CALL_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("INVALID");
    expect(report.control).toEqual({ attempted: false, allowed: false, timedOut: false });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });

  it("is INVALID when the control call was refused", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(DENIED_AGENT_LOG),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("INVALID");
    expect(report.control).toEqual({ attempted: true, allowed: false, timedOut: false });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });

  it("fails with an error line when the denied run rejects", async () => {
    const { runSession, requests } = scriptedSessions([new Error("spawn exploded\nsecond line")]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: false,
      denied: undefined,
      deniedForeign: [],
      control: undefined,
      controlForeign: [],
      error: "spawn exploded second line",
      verdict: "FAIL",
    });
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("fails when the retry rejects", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      new Error("boom"),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.retried).toBe(true);
    expect(report.denied).toBeUndefined();
    expect(report.error).toBe("boom");
    expect(requests).toEqual([deniedRequest("denied"), deniedRequest("denied-retry")]);
  });

  it("is INVALID when the control run rejects", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      new Error("boom"),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: false,
      denied: REFUSED_DENIAL,
      deniedForeign: [],
      control: undefined,
      controlForeign: [],
      error: "boom",
      verdict: "INVALID",
    });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });

  it("is INVALID when the retry is refused and the control run rejects", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      loggedSession(DENIED_AGENT_LOG),
      new Error("boom"),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("INVALID");
    expect(report.retried).toBe(true);
    expect(report.denied).toEqual(REFUSED_DENIAL);
    expect(report.control).toBeUndefined();
    expect(report.error).toBe("boom");
    expect(requests).toEqual([
      deniedRequest("denied"),
      deniedRequest("denied-retry"),
      CONTROL_REQUEST,
    ]);
  });

  it("fails at once, with no retry, when the first denied run made no call and used a foreign tool", async () => {
    const { runSession, requests } = scriptedSessions([loggedSession(logOf(READ_CALL))]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: false,
      denied: { attempted: false, refused: false, timedOut: false },
      deniedForeign: ["Read"],
      control: undefined,
      controlForeign: [],
      error: undefined,
      verdict: "FAIL",
    });
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("fails and starts no control run when a refused denied run also used a foreign tool", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(logOf(AGENT_CALL, READ_CALL_FROM_STARTED_AGENT, AGENT_CALL_REFUSED_RESULT)),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.denied).toEqual(REFUSED_DENIAL);
    expect(report.deniedForeign).toEqual(["Read"]);
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied")]);
  });

  it("takes the foreign names of the retry, the last denied run, and fails", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(NO_CALL_LOG),
      loggedSession(logOf(READ_CALL, GLOB_CALL)),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report.verdict).toBe("FAIL");
    expect(report.retried).toBe(true);
    expect(report.deniedForeign).toEqual(["Read", "Glob"]);
    expect(report.control).toBeUndefined();
    expect(requests).toEqual([deniedRequest("denied"), deniedRequest("denied-retry")]);
  });

  it("fails when the control run holds a foreign tool use", async () => {
    const { runSession, requests } = scriptedSessions([
      loggedSession(DENIED_AGENT_LOG),
      loggedSession(logOf(AGENT_CALL, AGENT_CALL_ALLOWED_RESULT_FOR_CALL, READ_CALL)),
    ]);

    const report = await runCase(AGENT_CASE, runSession);

    expect(report).toEqual({
      id: "agent-poteto",
      retried: false,
      denied: REFUSED_DENIAL,
      deniedForeign: [],
      control: ALLOWED_CONTROL,
      controlForeign: ["Read"],
      error: undefined,
      verdict: "FAIL",
    });
    expect(requests).toEqual([deniedRequest("denied"), CONTROL_REQUEST]);
  });
});

// ---------------------------------------------------------------------------------------------
// readDocsEntries
// ---------------------------------------------------------------------------------------------

describe("readDocsEntries", () => {
  const BOTH_ENTRIES = [AGENT_ENTRY, SKILL_ENTRY];

  it("returns the resolved settings path when both entries are present", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith(["Bash(rm:*)", AGENT_ENTRY, SKILL_ENTRY]));

      expect(readDocsEntries(docsRoot, BOTH_ENTRIES)).toBe(join(docsRoot, ".claude/settings.json"));
    });
  });

  it("resolves a relative docs root to an absolute path", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith(BOTH_ENTRIES));

      const returned = readDocsEntries(relative(process.cwd(), docsRoot), BOTH_ENTRIES);

      expect(returned).toBe(join(docsRoot, ".claude/settings.json"));
    });
  });

  it("refuses an unreadable settings file with its resolved path", async () => {
    await withScratchFolder((docsRoot) => {
      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe(
        `docs settings file is unreadable: ${join(docsRoot, ".claude/settings.json")}`,
      );
    });
  });

  it("refuses a settings file that is not valid JSON", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, "{ not json");

      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe(
        `docs settings file is not valid JSON: ${join(docsRoot, ".claude/settings.json")}`,
      );
    });
  });

  it.each([
    ["an object without permissions", "{}"],
    ["permissions without deny", '{"permissions":{}}'],
    ["a deny that is a string", '{"permissions":{"deny":"Agent(pstack:poteto-agent)"}}'],
    ["a top level array", "[]"],
  ])("refuses a settings file with no permissions.deny array: %s", async (_name, text) => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, text);

      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe(
        `docs settings file has no permissions.deny array: ${join(docsRoot, ".claude/settings.json")}`,
      );
    });
  });

  it("names the entry that is missing", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith([AGENT_ENTRY]));

      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe("docs settings lack the entry: Skill(pstack:setup-pstack)");
    });
  });

  it("names the first missing entry in case order when both are missing", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith(["Bash(rm:*)"]));

      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe("docs settings lack the entry: Agent(pstack:poteto-agent)");
    });
  });

  it("does not take a bare spelling for the entry", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith(["Agent(poteto-agent)", SKILL_ENTRY]));

      const message = refusalMessageOf(() => readDocsEntries(docsRoot, BOTH_ENTRIES));

      expect(message).toBe("docs settings lack the entry: Agent(pstack:poteto-agent)");
    });
  });

  it("checks only the entries it is given", async () => {
    await withScratchFolder((docsRoot) => {
      writeDocsSettings(docsRoot, settingsTextWith([SKILL_ENTRY]));

      expect(readDocsEntries(docsRoot, [SKILL_ENTRY])).toBe(
        join(docsRoot, ".claude/settings.json"),
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// main with injected dependencies
// ---------------------------------------------------------------------------------------------

const MODELS_TEXT = [
  "| Class | Model |",
  "|---|---|",
  "| Heavy | claude-test-heavy |",
  "| Standard | claude-test-standard |",
  "| Light | claude-test-light |",
  "",
  "| Job | Tier | Class |",
  "|---|---|---|",
  "| lookup | 3 | Light |",
  "",
].join("\n");

const FIXED_NOW = new Date("2026-11-06T10:00:00.000Z");
const HOME_RULE_FILE = ".claude/rules/pstack-models.md";

interface MainScratch {
  folder: string;
  docsRoot: string;
  homeFolder: string;
  modelsFile: string;
  outPath: string;
}

const withMainScratch = async (
  body: (scratch: MainScratch) => void | Promise<void>,
): Promise<void> => {
  await withScratchFolder(async (folder) => {
    const scratch: MainScratch = {
      folder,
      docsRoot: join(folder, "docs"),
      homeFolder: join(folder, "home"),
      modelsFile: join(folder, "models.md"),
      outPath: join(folder, "out.txt"),
    };
    writeDocsSettings(scratch.docsRoot, settingsTextWith(["Bash(rm:*)", AGENT_ENTRY, SKILL_ENTRY]));
    mkdirSync(scratch.homeFolder);
    writeFileSync(scratch.modelsFile, MODELS_TEXT);
    try {
      await body(scratch);
    } finally {
      removeAllFixtures();
    }
  });
};

interface MainRun {
  code: number;
  printed: string[];
  requests: Parameters<MainDeps["runSession"]>[0][];
}

const runMain = async (
  scratch: MainScratch,
  argv: string[],
  overrides: Partial<MainDeps> = {},
): Promise<MainRun> => {
  const printed: string[] = [];
  const requests: MainRun["requests"] = [];
  const innerSession = overrides.runSession ?? passingSession;
  const deps: MainDeps = {
    removeFixtureFolder,
    docsRoot: scratch.docsRoot,
    homeFolder: scratch.homeFolder,
    modelsFile: scratch.modelsFile,
    print: (line) => printed.push(line),
    readClaudeVersion: () => "9.9.9 (Test)",
    now: () => FIXED_NOW,
    environment: { DENY_PROOF_DOCS_ROOT: undefined },
    ...overrides,
    runSession: async (request) => {
      requests.push(request);
      return innerSession(request);
    },
  };
  const code = await main(argv, deps);
  return { code, printed, requests };
};

const outArguments = (scratch: MainScratch): string[] => ["--out", scratch.outPath];

const expectRefused = (
  run: MainRun,
  scratch: MainScratch,
  reason: string,
  existingOutText?: string,
): void => {
  expect(run.printed).toEqual([`pstack-guard-proof REFUSED: ${reason}`]);
  expect(run.code).toBe(2);
  expect(run.requests).toEqual([]);
  if (existingOutText === undefined) {
    expect(existsSync(scratch.outPath)).toBe(false);
  } else {
    expect(readFileSync(scratch.outPath, "utf8")).toBe(existingOutText);
  }
};

interface RefusalRow {
  name: string;
  arrange: (scratch: MainScratch) => { argv: string[]; overrides?: Partial<MainDeps> };
  reason: (scratch: MainScratch) => string;
  existingOutText?: string;
}

const breakDocsSettings = (scratch: MainScratch, text: string): void => {
  writeDocsSettings(scratch.docsRoot, text);
};

const SKILL_ENTRY_MISSING_REASON = "docs settings lack the entry: Skill(pstack:setup-pstack)";

const REFUSAL_ROWS: RefusalRow[] = [
  {
    name: "no --out option",
    arrange: () => ({ argv: [] }),
    reason: () => "--out is required",
  },
  {
    name: "an unexpected positional argument",
    arrange: (scratch) => ({ argv: [...outArguments(scratch), "extra"] }),
    reason: () => "unexpected argument: extra",
  },
  {
    name: "an unknown case id",
    arrange: (scratch) => ({ argv: [...outArguments(scratch), "--case", "nope"] }),
    reason: () => "unknown case: nope",
  },
  {
    name: "an --out parent folder that does not exist",
    arrange: (scratch) => ({ argv: ["--out", join(scratch.folder, "missing", "out.txt")] }),
    reason: (scratch) => `--out parent folder does not exist: ${join(scratch.folder, "missing")}`,
  },
  {
    name: "an --out parent that is a file",
    arrange: (scratch) => {
      writeFileSync(join(scratch.folder, "a-file"), "not a folder\n");
      return { argv: ["--out", join(scratch.folder, "a-file", "out.txt")] };
    },
    reason: (scratch) => `--out parent folder does not exist: ${join(scratch.folder, "a-file")}`,
  },
  {
    name: "an unreadable docs settings file",
    arrange: (scratch) => ({
      argv: outArguments(scratch),
      overrides: { docsRoot: join(scratch.folder, "no-docs") },
    }),
    reason: (scratch) =>
      `docs settings file is unreadable: ${join(scratch.folder, "no-docs", ".claude/settings.json")}`,
  },
  {
    name: "a docs settings file that is not valid JSON",
    arrange: (scratch) => {
      breakDocsSettings(scratch, "{ not json");
      return { argv: outArguments(scratch) };
    },
    reason: (scratch) =>
      `docs settings file is not valid JSON: ${join(scratch.docsRoot, ".claude/settings.json")}`,
  },
  {
    name: "a docs settings file with no permissions.deny array",
    arrange: (scratch) => {
      breakDocsSettings(scratch, '{"permissions":{}}');
      return { argv: outArguments(scratch) };
    },
    reason: (scratch) =>
      `docs settings file has no permissions.deny array: ${join(scratch.docsRoot, ".claude/settings.json")}`,
  },
  {
    name: "a docs settings file that lacks the entry",
    arrange: (scratch) => {
      breakDocsSettings(scratch, settingsTextWith([AGENT_ENTRY]));
      return { argv: outArguments(scratch) };
    },
    reason: () => SKILL_ENTRY_MISSING_REASON,
  },
  {
    name: "a models lookup that refuses",
    arrange: (scratch) => ({
      argv: outArguments(scratch),
      overrides: { modelsFile: join(scratch.folder, "no-models.md") },
    }),
    reason: (scratch) => `cannot read the model table at ${join(scratch.folder, "no-models.md")}`,
  },
];

const ORDER_ROWS: RefusalRow[] = [
  {
    name: "no --out comes before an unexpected argument",
    arrange: () => ({ argv: ["extra"] }),
    reason: () => "--out is required",
  },
  {
    name: "an unexpected argument comes before an unknown case",
    arrange: (scratch) => ({ argv: [...outArguments(scratch), "extra", "--case", "nope"] }),
    reason: () => "unexpected argument: extra",
  },
  {
    name: "a missing --out parent comes before a missing docs file",
    arrange: (scratch) => ({
      argv: ["--out", join(scratch.folder, "missing", "out.txt")],
      overrides: { docsRoot: join(scratch.folder, "no-docs") },
    }),
    reason: (scratch) => `--out parent folder does not exist: ${join(scratch.folder, "missing")}`,
  },
  {
    name: "a missing docs entry comes before a refusing models lookup",
    arrange: (scratch) => {
      breakDocsSettings(scratch, settingsTextWith([AGENT_ENTRY]));
      return {
        argv: outArguments(scratch),
        overrides: { modelsFile: join(scratch.folder, "no-models.md") },
      };
    },
    reason: () => SKILL_ENTRY_MISSING_REASON,
  },
  {
    name: "an unknown case comes before a missing docs file",
    arrange: (scratch) => ({
      argv: [...outArguments(scratch), "--case", "nope"],
      overrides: { docsRoot: join(scratch.folder, "no-docs") },
    }),
    reason: () => "unknown case: nope",
  },
  {
    name: "an existing --out path comes before a docs file that lacks an entry",
    arrange: (scratch) => {
      writeFileSync(scratch.outPath, "keep me\n");
      breakDocsSettings(scratch, settingsTextWith([AGENT_ENTRY]));
      return { argv: outArguments(scratch) };
    },
    reason: (scratch) => `--out names a path that exists: ${scratch.outPath}`,
    existingOutText: "keep me\n",
  },
];

describe("main refusals", () => {
  it.each(REFUSAL_ROWS)(
    "refuses $name, before any session and before the --out file",
    async (row) => {
      await withMainScratch(async (scratch) => {
        const { argv, overrides } = row.arrange(scratch);

        const run = await runMain(scratch, argv, overrides);

        expectRefused(run, scratch, row.reason(scratch));
      });
    },
  );

  it.each(ORDER_ROWS)("keeps the order: $name", async (row) => {
    await withMainScratch(async (scratch) => {
      const { argv, overrides } = row.arrange(scratch);

      const run = await runMain(scratch, argv, overrides);

      expectRefused(run, scratch, row.reason(scratch), row.existingOutText);
    });
  });

  it("refuses an existing --out path and leaves the file unchanged", async () => {
    await withMainScratch(async (scratch) => {
      writeFileSync(scratch.outPath, "keep me\n");

      const run = await runMain(scratch, outArguments(scratch));

      expect(run.printed).toEqual([
        `pstack-guard-proof REFUSED: --out names a path that exists: ${scratch.outPath}`,
      ]);
      expect(run.code).toBe(2);
      expect(run.requests).toEqual([]);
      expect(readFileSync(scratch.outPath, "utf8")).toBe("keep me\n");
    });
  });

  it("refuses an unknown case before an existing --out path", async () => {
    await withMainScratch(async (scratch) => {
      writeFileSync(scratch.outPath, "keep me\n");

      const run = await runMain(scratch, [...outArguments(scratch), "--case", "nope"]);

      expect(run.printed).toEqual(["pstack-guard-proof REFUSED: unknown case: nope"]);
    });
  });

  it("refuses a docs file that lacks an entry before any session starts", async () => {
    await withMainScratch(async (scratch) => {
      breakDocsSettings(scratch, settingsTextWith([AGENT_ENTRY]));

      const run = await runMain(scratch, outArguments(scratch));

      expect(run.requests).toEqual([]);
      expect(run.code).toBe(2);
      expect(fixtureFolders().filter((folder) => existsSync(folder))).toEqual([]);
    });
  });

  it("creates the --out file only after the refusals passed", async () => {
    await withMainScratch(async (scratch) => {
      const refusing = await runMain(scratch, outArguments(scratch), {
        modelsFile: join(scratch.folder, "no-models.md"),
      });

      expect(refusing.code).toBe(2);
      expect(existsSync(scratch.outPath)).toBe(false);

      const passing = await runMain(scratch, outArguments(scratch));

      expect(passing.code).toBe(0);
      expect(existsSync(scratch.outPath)).toBe(true);
    });
  });

  it("prints a refusal from a helper in the refusal form and exits 2", async () => {
    await withMainScratch(async (scratch) => {
      const badModels = join(scratch.folder, "bad-models.md");
      writeFileSync(
        badModels,
        ["| Class | Model |", "|---|---|", "| Odd | claude-x |", ""].join("\n"),
      );

      const run = await runMain(scratch, outArguments(scratch), { modelsFile: badModels });

      expectRefused(run, scratch, `${badModels} line 3: unknown class "Odd"`);
    });
  });

  it("prints a parseCliArgs error in the refusal form and exits 2", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, [...outArguments(scratch), "--bogus"]);

      expect(run.printed).toHaveLength(1);
      expect(run.printed[0]).toMatch(/^pstack-guard-proof REFUSED: Unknown option '--bogus'/);
      expect(run.code).toBe(2);
      expect(run.requests).toEqual([]);
      expect(existsSync(scratch.outPath)).toBe(false);
    });
  });
});

describe("main runs", () => {
  const expectedHeader = (scratch: MainScratch): string[] => [
    "pstack-guard-proof started 2026-11-06T10:00:00.000Z",
    "claude: 9.9.9 (Test)",
    "model: claude-test-light",
    `docs settings: ${join(scratch.docsRoot, ".claude/settings.json")}`,
    "docs root override: none",
  ];

  it("prints the full output of a PASS run and exits 0", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, outArguments(scratch));

      expect(run.printed).toEqual([
        ...expectedHeader(scratch),
        "CASE agent-poteto",
        "  denied run: attempted=true refused=true timed_out=false",
        "  control run: attempted=true allowed=true timed_out=false",
        "  verdict: PASS",
        "CASE skill-setup",
        "  denied run: attempted=true refused=true timed_out=false",
        "  control run: attempted=true allowed=true timed_out=false",
        "  verdict: PASS",
        "pstack-guard-proof PASSED",
      ]);
      expect(run.code).toBe(0);
    });
  });

  it("prints the full output of a FAIL run and exits 1", async () => {
    await withMainScratch(async (scratch) => {
      const agentDeniedButAllowed: RunSession = async (request) =>
        request.caseId === "agent-poteto" && request.run === "denied"
          ? loggedSession(ALLOWED_AGENT_LOG)
          : passingSession(request);

      const run = await runMain(scratch, outArguments(scratch), {
        runSession: agentDeniedButAllowed,
      });

      expect(run.printed).toEqual([
        ...expectedHeader(scratch),
        "CASE agent-poteto",
        "  denied run: attempted=true refused=false timed_out=false",
        "  control run: not started",
        "  verdict: FAIL",
        "CASE skill-setup",
        "  denied run: attempted=true refused=true timed_out=false",
        "  control run: attempted=true allowed=true timed_out=false",
        "  verdict: PASS",
        "pstack-guard-proof FAILED (1 cases not PASS, 0 postcheck failures)",
      ]);
      expect(run.code).toBe(1);
    });
  });

  it("prints the docs root override and the unknown claude version in the header", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, outArguments(scratch), {
        readClaudeVersion: () => "unknown",
        environment: { DENY_PROOF_DOCS_ROOT: scratch.docsRoot },
      });

      expect(run.printed[1]).toBe("claude: unknown");
      expect(run.printed[4]).toBe(`docs root override: ${scratch.docsRoot}`);
    });
  });

  it("prints docs root override: none for an empty DENY_PROOF_DOCS_ROOT", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, outArguments(scratch), {
        environment: { DENY_PROOF_DOCS_ROOT: "" },
      });

      expect(run.printed[4]).toBe("docs root override: none");
      expect(run.code).toBe(0);
    });
  });

  it("appends every printed line to the --out file, byte for byte", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, outArguments(scratch));

      const fileText = readFileSync(scratch.outPath, "utf8");

      expect(fileText).toBe(run.printed.map((line) => `${line}\n`).join(""));
    });
  });

  it("runs only the case named by --case", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, [...outArguments(scratch), "--case", "skill-setup"]);

      expect(run.requests.map((request) => request.caseId)).toEqual(["skill-setup", "skill-setup"]);
      expect(run.printed).toContain("CASE skill-setup");
      expect(run.printed).not.toContain("CASE agent-poteto");
      expect(run.printed.at(-1)).toBe("pstack-guard-proof PASSED");
      expect(run.code).toBe(0);
    });
  });

  it("checks only the entry of the selected case", async () => {
    await withMainScratch(async (scratch) => {
      breakDocsSettings(scratch, settingsTextWith([SKILL_ENTRY]));

      const run = await runMain(scratch, [...outArguments(scratch), "--case", "skill-setup"]);

      expect(run.code).toBe(0);
    });
  });

  it("completes each request with the model and the log prefix", async () => {
    await withMainScratch(async (scratch) => {
      const run = await runMain(scratch, outArguments(scratch));

      expect(
        run.requests.map((request) => [request.run, request.model, request.logPrefix]),
      ).toEqual([
        ["denied", "claude-test-light", `${scratch.outPath}.agent-poteto.denied`],
        ["control", "claude-test-light", `${scratch.outPath}.agent-poteto.control`],
        ["denied", "claude-test-light", `${scratch.outPath}.skill-setup.denied`],
        ["control", "claude-test-light", `${scratch.outPath}.skill-setup.control`],
      ]);
    });
  });

  it("resolves a relative --out path for the file and the log prefix", async () => {
    await withMainScratch(async (scratch) => {
      const relativeOut = relative(process.cwd(), scratch.outPath);

      const run = await runMain(scratch, ["--out", relativeOut]);

      expect(run.code).toBe(0);
      expect(run.requests[0]?.logPrefix).toBe(`${scratch.outPath}.agent-poteto.denied`);
      expect(existsSync(scratch.outPath)).toBe(true);
    });
  });

  it("removes a fixture left in place by a session, in the finally", async () => {
    await withMainScratch(async (scratch) => {
      let leftFixture: string | undefined;
      const leavingFixture: RunSession = async (request) => {
        leftFixture ??= makeFixture(request.entry);
        return passingSession(request);
      };

      const run = await runMain(scratch, outArguments(scratch), { runSession: leavingFixture });

      expect(leftFixture).toBeDefined();
      expect(fixtureFolders()).toContain(leftFixture);
      expect(existsSync(leftFixture ?? "")).toBe(false);
      expect(run.printed.some((line) => line.startsWith("POSTCHECK"))).toBe(false);
      expect(run.code).toBe(0);
    });
  });

  it("reports a fixture that survived its teardown and exits 1", async () => {
    await withMainScratch(async (scratch) => {
      let leftFixture = "";
      const leavingFixture: RunSession = async (request) => {
        if (leftFixture === "") leftFixture = makeFixture(request.entry);
        return passingSession(request);
      };

      const run = await runMain(scratch, outArguments(scratch), {
        runSession: leavingFixture,
        removeFixtureFolder: () => undefined,
      });
      removeFixtureFolder(leftFixture);

      expect(run.printed.slice(-2)).toEqual([
        `POSTCHECK FAILED: ${leftFixture} survived its teardown`,
        "pstack-guard-proof FAILED (0 cases not PASS, 1 postcheck failures)",
      ]);
      expect(run.code).toBe(1);
      expect(existsSync(leftFixture)).toBe(false);
    });
  });

  it("reports a home file created by a session and exits 1", async () => {
    await withMainScratch(async (scratch) => {
      const homeFile = resolve(scratch.homeFolder, HOME_RULE_FILE);
      let written = false;
      const writingHomeFile: RunSession = async (request) => {
        if (!written) {
          mkdirSync(join(scratch.homeFolder, ".claude/rules"), { recursive: true });
          writeFileSync(homeFile, "written by a session\n");
          written = true;
        }
        return passingSession(request);
      };

      const run = await runMain(scratch, outArguments(scratch), { runSession: writingHomeFile });

      expect(run.printed.slice(-2)).toEqual([
        `POSTCHECK FAILED: ${homeFile} was created by a session`,
        "pstack-guard-proof FAILED (0 cases not PASS, 1 postcheck failures)",
      ]);
      expect(run.code).toBe(1);
    });
  });

  it("prints the survivor lines before the home file lines, in the --out file as well", async () => {
    await withMainScratch(async (scratch) => {
      const homeFile = resolve(scratch.homeFolder, HOME_RULE_FILE);
      let leftFixture = "";
      const leavingTraces: RunSession = async (request) => {
        if (leftFixture === "") {
          leftFixture = makeFixture(request.entry);
          mkdirSync(join(scratch.homeFolder, ".claude/rules"), { recursive: true });
          writeFileSync(homeFile, "written by a session\n");
        }
        return passingSession(request);
      };

      const run = await runMain(scratch, outArguments(scratch), {
        runSession: leavingTraces,
        removeFixtureFolder: () => undefined,
      });
      removeFixtureFolder(leftFixture);

      expect(run.printed.slice(-3)).toEqual([
        `POSTCHECK FAILED: ${leftFixture} survived its teardown`,
        `POSTCHECK FAILED: ${homeFile} was created by a session`,
        "pstack-guard-proof FAILED (0 cases not PASS, 2 postcheck failures)",
      ]);
      expect(readFileSync(scratch.outPath, "utf8")).toBe(
        run.printed.map((line) => `${line}\n`).join(""),
      );
    });
  });

  it("exits 1 with the message on stderr for another thrown error, and still runs the finally", async () => {
    await withMainScratch(async (scratch) => {
      const earlierFixture = makeFixture(undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const run = await runMain(scratch, outArguments(scratch), {
          readClaudeVersion: () => {
            throw new Error("version exploded");
          },
        });

        expect(run.code).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith("version exploded");
        expect(run.printed).toEqual([]);
        expect(run.requests).toEqual([]);
        expect(existsSync(earlierFixture)).toBe(false);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Output lines
// ---------------------------------------------------------------------------------------------

describe("formatCase", () => {
  const baseReport: CaseReport = {
    id: "agent-poteto",
    retried: false,
    denied: { attempted: true, refused: true, timedOut: false },
    deniedForeign: [],
    control: { attempted: true, allowed: true, timedOut: false },
    controlForeign: [],
    error: undefined,
    verdict: "PASS",
  };

  it("prints a PASS case", () => {
    expect(formatCase(baseReport)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=true timed_out=false",
      "  control run: attempted=true allowed=true timed_out=false",
      "  verdict: PASS",
    ]);
  });

  it("prints the retry line after the case line", () => {
    expect(formatCase({ ...baseReport, retried: true })).toEqual([
      "CASE agent-poteto",
      "  denied run retried: the model did not attempt the call",
      "  denied run: attempted=true refused=true timed_out=false",
      "  control run: attempted=true allowed=true timed_out=false",
      "  verdict: PASS",
    ]);
  });

  it("prints timed_out=true on both runs", () => {
    const report: CaseReport = {
      ...baseReport,
      denied: { attempted: true, refused: false, timedOut: true },
      control: { attempted: false, allowed: false, timedOut: true },
      verdict: "FAIL",
    };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=false timed_out=true",
      "  control run: attempted=false allowed=false timed_out=true",
      "  verdict: FAIL",
    ]);
  });

  it("prints a denied run that threw, a control run not started and the error", () => {
    const report: CaseReport = {
      ...baseReport,
      denied: undefined,
      control: undefined,
      error: "spawn exploded",
      verdict: "FAIL",
    };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: error",
      "  control run: not started",
      "  error: spawn exploded",
      "  verdict: FAIL",
    ]);
  });

  it("prints a control run that threw and the error", () => {
    const report: CaseReport = {
      ...baseReport,
      control: undefined,
      error: "spawn exploded",
      verdict: "INVALID",
    };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=true timed_out=false",
      "  control run: error",
      "  error: spawn exploded",
      "  verdict: INVALID",
    ]);
  });

  it("prints the foreign tool use of the denied run directly after the denied run line", () => {
    const report: CaseReport = {
      ...baseReport,
      deniedForeign: ["Read", "Glob"],
      control: undefined,
      verdict: "FAIL",
    };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=true timed_out=false",
      "  denied run foreign tool use: Read, Glob",
      "  control run: not started",
      "  verdict: FAIL",
    ]);
  });

  it("prints the foreign tool use of the control run directly after the control run line", () => {
    const report: CaseReport = { ...baseReport, controlForeign: ["Read"], verdict: "FAIL" };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=true timed_out=false",
      "  control run: attempted=true allowed=true timed_out=false",
      "  control run foreign tool use: Read",
      "  verdict: FAIL",
    ]);
  });

  it("prints a control run not started after a denied run that was not refused", () => {
    const report: CaseReport = {
      ...baseReport,
      denied: { attempted: true, refused: false, timedOut: false },
      control: undefined,
      verdict: "FAIL",
    };

    expect(formatCase(report)).toEqual([
      "CASE agent-poteto",
      "  denied run: attempted=true refused=false timed_out=false",
      "  control run: not started",
      "  verdict: FAIL",
    ]);
  });
});

describe("formatFinalLine and exitCodeOf", () => {
  it("prints PASSED when nothing failed", () => {
    expect(formatFinalLine(0, 0)).toBe("pstack-guard-proof PASSED");
  });

  it("prints FAILED with both counts otherwise", () => {
    expect(formatFinalLine(2, 0)).toBe(
      "pstack-guard-proof FAILED (2 cases not PASS, 0 postcheck failures)",
    );
    expect(formatFinalLine(0, 1)).toBe(
      "pstack-guard-proof FAILED (0 cases not PASS, 1 postcheck failures)",
    );
    expect(formatFinalLine(1, 3)).toBe(
      "pstack-guard-proof FAILED (1 cases not PASS, 3 postcheck failures)",
    );
  });

  it("exits 0 for nothing failed and 1 for any failure", () => {
    expect(exitCodeOf(0, 0)).toBe(0);
    expect(exitCodeOf(1, 0)).toBe(1);
    expect(exitCodeOf(0, 1)).toBe(1);
    expect(exitCodeOf(2, 3)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The home files
// ---------------------------------------------------------------------------------------------

describe("snapshotHomeFiles and homeFileProblems", () => {
  const RULE_FILE = ".claude/rules/pstack-models.md";
  const CURSOR_FILE = ".cursor/rules/pstack-models.mdc";

  const writeHomeFile = (home: string, relativePath: string, text: string): void => {
    mkdirSync(join(home, relativePath, ".."), { recursive: true });
    writeFileSync(join(home, relativePath), text);
  };

  it("records whether each of the two files exists, with its hash and absolute path", async () => {
    await withScratchFolder((home) => {
      writeHomeFile(home, RULE_FILE, "abc");

      expect(snapshotHomeFiles(home)).toEqual([
        {
          path: join(home, RULE_FILE),
          exists: true,
          sha256: createHash("sha256").update("abc").digest("hex"),
        },
        { path: join(home, CURSOR_FILE), exists: false, sha256: undefined },
      ]);
    });
  });

  it("reports nothing for two snapshots of absent files", async () => {
    await withScratchFolder((home) => {
      expect(homeFileProblems(snapshotHomeFiles(home), snapshotHomeFiles(home))).toEqual([]);
    });
  });

  it("reports nothing for an unchanged file", async () => {
    await withScratchFolder((home) => {
      writeHomeFile(home, RULE_FILE, "same");
      const before = snapshotHomeFiles(home);

      expect(homeFileProblems(before, snapshotHomeFiles(home))).toEqual([]);
    });
  });

  it("reports a created file", async () => {
    await withScratchFolder((home) => {
      const before = snapshotHomeFiles(home);
      writeHomeFile(home, CURSOR_FILE, "new");

      expect(homeFileProblems(before, snapshotHomeFiles(home))).toEqual([
        `POSTCHECK FAILED: ${join(home, CURSOR_FILE)} was created by a session`,
      ]);
    });
  });

  it("reports a changed file", async () => {
    await withScratchFolder((home) => {
      writeHomeFile(home, RULE_FILE, "before");
      const before = snapshotHomeFiles(home);
      writeHomeFile(home, RULE_FILE, "after");

      expect(homeFileProblems(before, snapshotHomeFiles(home))).toEqual([
        `POSTCHECK FAILED: ${join(home, RULE_FILE)} was changed by a session`,
      ]);
    });
  });

  it("reports a removed file", async () => {
    await withScratchFolder((home) => {
      writeHomeFile(home, RULE_FILE, "before");
      const before = snapshotHomeFiles(home);
      rmSync(join(home, RULE_FILE));

      expect(homeFileProblems(before, snapshotHomeFiles(home))).toEqual([
        `POSTCHECK FAILED: ${join(home, RULE_FILE)} was removed by a session`,
      ]);
    });
  });

  it("reports both files in the order of the two paths", async () => {
    await withScratchFolder((home) => {
      writeHomeFile(home, CURSOR_FILE, "before");
      const before = snapshotHomeFiles(home);
      writeHomeFile(home, RULE_FILE, "created");
      rmSync(join(home, CURSOR_FILE));

      expect(homeFileProblems(before, snapshotHomeFiles(home))).toEqual([
        `POSTCHECK FAILED: ${join(home, RULE_FILE)} was created by a session`,
        `POSTCHECK FAILED: ${join(home, CURSOR_FILE)} was removed by a session`,
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------------

interface SignalRecord {
  calls: string[];
  printed: string[];
}

const recordingSignalDeps = (overrides: Partial<SignalDeps> = {}): [SignalDeps, SignalRecord] => {
  const record: SignalRecord = { calls: [], printed: [] };
  const deps: SignalDeps = {
    runningPids: () => [],
    stopSession: (pid) => record.calls.push(`stop:${pid}`),
    wait: (milliseconds) => record.calls.push(`wait:${milliseconds}`),
    killSession: (pid) => record.calls.push(`kill:${pid}`),
    fixtureFolders: () => [],
    removeFixtures: () => record.calls.push("remove"),
    isAlive: (pid) => {
      record.calls.push(`alive:${pid}`);
      return false;
    },
    homeFileProblems: () => {
      record.calls.push("home");
      return [];
    },
    print: (line) => record.printed.push(line),
    exit: (code) => record.calls.push(`exit:${code}`),
    ...overrides,
  };
  return [deps, record];
};

describe("installSignalHandlers", () => {
  it("registers SIGINT, SIGTERM and SIGHUP once each, and each handler exits with its code", () => {
    const registered: { signal: string; handler: () => void }[] = [];
    const target = {
      on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): void => {
        registered.push({ signal, handler });
      },
    };
    const [deps, record] = recordingSignalDeps();

    installSignalHandlers(target, deps);

    expect(registered.map((entry) => entry.signal)).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    for (const entry of registered) entry.handler();
    expect(record.calls.filter((call) => call.startsWith("exit:"))).toEqual([
      "exit:130",
      "exit:143",
      "exit:129",
    ]);
    expect(record.printed.filter((line) => line.startsWith("SIGNAL SIG"))).toEqual([
      "SIGNAL SIGINT: stopping 0 running session(s)",
      "SIGNAL SIGTERM: stopping 0 running session(s)",
      "SIGNAL SIGHUP: stopping 0 running session(s)",
    ]);
  });
});

describe("terminateAfterSignal", () => {
  it("prints the lines in order and calls the deps in the order stop, wait, alive check, remove, alive check, home, exit", async () => {
    await withScratchFolder((scratch) => {
      const present = join(scratch, "present");
      mkdirSync(present);
      const [deps, record] = recordingSignalDeps({
        runningPids: () => [101, 102],
        fixtureFolders: () => [present, join(scratch, "absent")],
        removeFixtures: () => {
          record.calls.push("remove");
          rmSync(present, { recursive: true });
        },
      });

      terminateAfterSignal("SIGTERM", 143, deps);

      expect(record.printed).toEqual([
        "SIGNAL SIGTERM: stopping 2 running session(s)",
        "SIGNAL: 2 session(s) told to stop, 1 fixture(s) still in place",
        "SIGNAL: removing the fixtures",
        "POSTCHECK after signal: sessions still alive: []",
        "POSTCHECK after signal: fixtures still present: []",
        "POSTCHECK after signal: home file problems: []",
      ]);
      expect(record.calls).toEqual([
        "stop:101",
        "stop:102",
        "wait:2000",
        "alive:101",
        "alive:102",
        "remove",
        "alive:101",
        "alive:102",
        "home",
        "exit:143",
      ]);
    });
  });

  it("kills a session that is still alive after the wait, before the fixtures are removed", () => {
    let killedSession111 = false;
    const [deps, record] = recordingSignalDeps({
      runningPids: () => [111, 222],
      killSession: (pid) => {
        record.calls.push(`kill:${pid}`);
        if (pid === 111) killedSession111 = true;
      },
      isAlive: (pid) => {
        record.calls.push(`alive:${pid}`);
        return pid === 111 && !killedSession111;
      },
    });

    terminateAfterSignal("SIGTERM", 143, deps);

    expect(record.calls).toEqual([
      "stop:111",
      "stop:222",
      "wait:2000",
      "alive:111",
      "kill:111",
      "alive:222",
      "remove",
      "alive:111",
      "alive:222",
      "home",
      "exit:143",
    ]);
    expect(record.printed).toContain("POSTCHECK after signal: sessions still alive: []");
  });

  it("prints no snapshot when the home file check has no snapshot to compare with", () => {
    const [deps, record] = recordingSignalDeps({ homeFileProblems: () => undefined });

    terminateAfterSignal("SIGHUP", 129, deps);

    expect(record.printed.at(-1)).toBe("POSTCHECK after signal: home file problems: no snapshot");
    expect(record.calls.at(-1)).toBe("exit:129");
  });

  it("lists the sessions still alive, the fixtures still present and the home file problems", async () => {
    await withScratchFolder((scratch) => {
      const stubborn = join(scratch, "stubborn");
      mkdirSync(stubborn);
      const [deps, record] = recordingSignalDeps({
        runningPids: () => [101, 102],
        isAlive: (pid) => pid === 102,
        fixtureFolders: () => [stubborn],
        homeFileProblems: () => ["POSTCHECK FAILED: /home/x was created by a session"],
      });

      terminateAfterSignal("SIGINT", 130, deps);

      expect(record.printed.slice(-3)).toEqual([
        "POSTCHECK after signal: sessions still alive: [102]",
        `POSTCHECK after signal: fixtures still present: ${JSON.stringify([stubborn])}`,
        'POSTCHECK after signal: home file problems: ["POSTCHECK FAILED: /home/x was created by a session"]',
      ]);
      expect(record.calls.at(-1)).toBe("exit:130");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const gitTopLevelOf = (folder: string): string => {
  const environment = { ...process.env };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_INDEX_FILE;
  const result = spawnSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], {
    env: environment,
    encoding: "utf8",
  });
  return result.stdout.trim();
};

describe("makeFixture", () => {
  it("makes a prefixed git work tree under the system temp directory with the settings text", async () => {
    await withTemporaryTmpdir((_base, tmp) => {
      const folder = makeFixture("Agent(pstack:poteto-agent)");

      expect(folder.startsWith(join(tmp, "lk-pstack-guard-proof-"))).toBe(true);
      expect(readFileSync(join(folder, ".claude/settings.json"), "utf8")).toBe(
        '{"permissions":{"deny":["Agent(pstack:poteto-agent)"]}}\n',
      );
      expect(gitTopLevelOf(folder)).toBe(realpathSync(folder));
      expect(fixtureFolders()).toContain(folder);
    });
  });

  it("holds an empty deny array for undefined", async () => {
    await withTemporaryTmpdir(() => {
      const folder = makeFixture(undefined);

      expect(readFileSync(join(folder, ".claude/settings.json"), "utf8")).toBe(
        '{"permissions":{"deny":[]}}\n',
      );
      expect(fixtureFolders()).toContain(folder);
    });
  });

  it("ignores every GIT_ variable of the environment and makes its own .git folder", async () => {
    await withTemporaryTmpdir((base) => {
      const elsewhere = join(base, "elsewhere.git");
      const originalGitDir = process.env.GIT_DIR;
      const originalConfigCount = process.env.GIT_CONFIG_COUNT;
      process.env.GIT_DIR = elsewhere;
      process.env.GIT_CONFIG_COUNT = "1";
      try {
        const folder = makeFixture(undefined);

        expect(existsSync(join(folder, ".git"))).toBe(true);
        expect(existsSync(elsewhere)).toBe(false);
      } finally {
        if (originalGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = originalGitDir;
        if (originalConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
        else process.env.GIT_CONFIG_COUNT = originalConfigCount;
      }
    });
  });

  it("refuses a folder that is not its own git work tree, and keeps it listed for the teardown", async () => {
    await withTemporaryTmpdir(async (base) => {
      const fakeBin = join(base, "bin");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "git"), "#!/bin/sh\necho /elsewhere\n");
      chmodSync(join(fakeBin, "git"), 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
      const before = fixtureFolders().length;
      try {
        expect(() => makeFixture(undefined)).toThrow(/is not its own git work tree/);
      } finally {
        process.env.PATH = originalPath;
      }

      expect(fixtureFolders()).toHaveLength(before + 1);
    });
  });
});

describe("removeFixtureFolder", () => {
  it("removes a prefixed folder under the system temp directory", async () => {
    await withTemporaryTmpdir((_base, tmp) => {
      const folder = join(tmp, "lk-pstack-guard-proof-a");
      mkdirSync(folder);
      writeFileSync(join(folder, "inside.txt"), "x");

      removeFixtureFolder(folder);

      expect(existsSync(folder)).toBe(false);
    });
  });

  it("returns without error for a folder that does not exist", async () => {
    await withTemporaryTmpdir((_base, tmp) => {
      expect(() => removeFixtureFolder(join(tmp, "lk-pstack-guard-proof-absent"))).not.toThrow();
    });
  });

  it("refuses a folder without the prefix", async () => {
    await withTemporaryTmpdir((_base, tmp) => {
      const folder = join(tmp, "keep-me");
      mkdirSync(folder);

      expect(() => removeFixtureFolder(folder)).toThrow(/refusing to remove/);
      expect(existsSync(folder)).toBe(true);
    });
  });

  it("refuses a prefixed folder outside the system temp directory", async () => {
    await withTemporaryTmpdir((base) => {
      const folder = join(base, "outside", "lk-pstack-guard-proof-2");
      mkdirSync(folder, { recursive: true });

      expect(() => removeFixtureFolder(folder)).toThrow(/refusing to remove/);
      expect(existsSync(folder)).toBe(true);
    });
  });

  it("refuses a prefixed folder in a sibling of the system temp directory", async () => {
    await withTemporaryTmpdir((base) => {
      const folder = join(base, "tmpx", "lk-pstack-guard-proof-1");
      mkdirSync(folder, { recursive: true });

      expect(() => removeFixtureFolder(folder)).toThrow(/refusing to remove/);
      expect(existsSync(folder)).toBe(true);
    });
  });

  it("refuses a prefixed folder nested below the system temp directory", async () => {
    await withTemporaryTmpdir((_base, tmp) => {
      const folder = join(tmp, "nested", "lk-pstack-guard-proof-3");
      mkdirSync(folder, { recursive: true });

      expect(() => removeFixtureFolder(folder)).toThrow(/refusing to remove/);
      expect(existsSync(folder)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// runClaudeSession against a stand-in for `claude`
// ---------------------------------------------------------------------------------------------

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const pollUntil = async (condition: () => boolean, limitMs: number): Promise<boolean> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > limitMs) return false;
    await sleep(20);
  }
  return true;
};

const waitUntil = async (condition: () => boolean): Promise<void> => {
  if (!(await pollUntil(condition, 5_000))) throw new Error("the condition was not met in time");
};

const writeExecutable = (path: string, lines: string[]): void => {
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
};

// A session that has exited is a zombie until its parent reaps it, so a zombie counts as gone.
const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return !state.stdout.trim().startsWith("Z");
};

// The file is created empty before the pid is written, and pids 0 and 1 are never a stand-in.
const readStandInPid = (pidFile: string): number | undefined => {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
};

const killProcessIfAlive = (pid: number | undefined): void => {
  if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGKILL");
};

// Sleeps one second at a time, so a killed stand-in leaves a sleep that ends within a second, and
// stops by itself after a minute if a test is cut short before it can kill the stand-in.
const SLEEP_ONE_SECOND_FOR_A_MINUTE = `for tick in ${Array.from({ length: 60 }, (_, index) => index + 1).join(" ")}; do sleep 1; done`;

const sessionRequestAt = (logPrefix: string): Parameters<typeof runClaudeSession>[0] => ({
  caseId: "agent-poteto",
  run: "denied",
  entry: "Agent(pstack:poteto-agent)",
  prompt: "Reply with one word.",
  model: "claude-test-light",
  logPrefix,
});

describe("runClaudeSession", () => {
  it("starts the binary with the session arguments in a registered fixture and logs both streams", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const argsFile = join(scratch, "args.txt");
        const cwdFile = join(scratch, "cwd.txt");
        const logFile = join(scratch, "stdout-source.txt");
        writeFileSync(logFile, DENIED_AGENT_LOG);
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > '${argsFile}'`,
          `pwd -P > '${cwdFile}'`,
          `cat '${logFile}'`,
          "echo 'stand-in stderr' 1>&2",
        ]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");
        const foldersBefore = fixtureFolders();

        const result = await runClaudeSession(sessionRequestAt(logPrefix), {
          claudeBinary: binary,
        });

        const recordedArguments = readFileSync(argsFile, "utf8").trimEnd().split("\n");
        expect(recordedArguments).toEqual(
          buildSessionArguments("Reply with one word.", "claude-test-light"),
        );
        const newFolders = fixtureFolders().filter((folder) => !foldersBefore.includes(folder));
        expect(newFolders).toHaveLength(1);
        const [fixture = ""] = newFolders;
        expect(readFileSync(cwdFile, "utf8").trim()).toBe(realpathSync(fixture));
        expect(readFileSync(join(fixture, ".claude/settings.json"), "utf8")).toBe(
          '{"permissions":{"deny":["Agent(pstack:poteto-agent)"]}}\n',
        );
        expect(result).toEqual({ timedOut: false, log: DENIED_AGENT_LOG });
        expect(readFileSync(`${logPrefix}.jsonl`, "utf8")).toBe(DENIED_AGENT_LOG);
        expect(readFileSync(`${logPrefix}.stderr.txt`, "utf8")).toBe("stand-in stderr\n");
        expect(runningSessionPids()).toEqual([]);
        expect(existsSync(fixture)).toBe(true);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("rejects a second call with the same log prefix before it makes a fixture or starts a process", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const markerFile = join(scratch, "started.txt");
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, ["#!/bin/sh", `echo started >> '${markerFile}'`]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");
        await runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: binary });
        const foldersAfterFirst = fixtureFolders();

        await expect(
          runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: binary }),
        ).rejects.toThrow(/EEXIST/);

        expect(fixtureFolders()).toEqual(foldersAfterFirst);
        expect(readFileSync(markerFile, "utf8")).toBe("started\n");
        expect(runningSessionPids()).toEqual([]);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("leaves no log file behind when the second log file already exists", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");
        writeFileSync(`${logPrefix}.stderr.txt`, "taken\n");
        const foldersBefore = fixtureFolders();

        await expect(
          runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: join(scratch, "unused") }),
        ).rejects.toThrow(/EEXIST/);

        expect(existsSync(`${logPrefix}.jsonl`)).toBe(false);
        expect(readFileSync(`${logPrefix}.stderr.txt`, "utf8")).toBe("taken\n");
        expect(fixtureFolders()).toEqual(foldersBefore);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("returns timedOut true for a binary that runs past the limit", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, ["#!/bin/sh", "while true; do sleep 1; done"]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");

        const result = await runClaudeSession(sessionRequestAt(logPrefix), {
          claudeBinary: binary,
          limitMs: 300,
        });

        expect(result).toEqual({ timedOut: true, log: "" });
        expect(runningSessionPids()).toEqual([]);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("ends a binary that ignores SIGTERM with SIGKILL after the grace period", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const readyFile = join(scratch, "trap-installed.txt");
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, [
          "#!/bin/sh",
          "trap '' TERM",
          `echo ready > '${readyFile}'`,
          "while true; do sleep 1; done",
        ]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");
        const startedAt = Date.now();

        // A script written a moment ago can take half a second to start; the limit leaves room for
        // that, so SIGTERM arrives after the trap is installed.
        const result = await runClaudeSession(sessionRequestAt(logPrefix), {
          claudeBinary: binary,
          limitMs: 3_000,
          killGraceMs: 500,
        });

        expect(result).toEqual({ timedOut: true, log: "" });
        expect(existsSync(readyFile), "the stand-in did not start before the limit").toBe(true);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_400);
        expect(runningSessionPids()).toEqual([]);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("lists the pid of a running session and drops it when the session ends", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, ["#!/bin/sh", "while true; do sleep 1; done"]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");

        const running = runClaudeSession(sessionRequestAt(logPrefix), {
          claudeBinary: binary,
          limitMs: 60_000,
        });
        await waitUntil(() => runningSessionPids().length === 1);
        const [pid = 0] = runningSessionPids();
        expect(() => process.kill(pid, 0)).not.toThrow();
        process.kill(pid, "SIGTERM");
        const result = await running;

        expect(result.timedOut).toBe(false);
        expect(runningSessionPids()).toEqual([]);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("rejects when the binary cannot be started and lists no pid", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");

        await expect(
          runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: join(scratch, "missing") }),
        ).rejects.toThrow(/ENOENT/);

        expect(runningSessionPids()).toEqual([]);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("hands the session no GIT_ variable while the test environment holds GIT_DIR", async () => {
    await withScratchFolder(async (scratch) => {
      const originalGitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = join(scratch, "elsewhere.git");
      try {
        const namesFile = join(scratch, "git-names.txt");
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, ["#!/bin/sh", `env | cut -d= -f1 | grep '^GIT_' > '${namesFile}'`]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");

        await runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: binary });

        expect(readFileSync(namesFile, "utf8")).toBe("");
        expect(existsSync(join(scratch, "elsewhere.git"))).toBe(false);
      } finally {
        if (originalGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = originalGitDir;
        removeAllFixtures();
      }
    });
  });

  it("creates both log files readable and writable by their owner only", async () => {
    await withScratchFolder(async (scratch) => {
      try {
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, ["#!/bin/sh", "echo out", "echo err 1>&2"]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");

        await runClaudeSession(sessionRequestAt(logPrefix), { claudeBinary: binary });

        expect(statSync(`${logPrefix}.jsonl`).mode & 0o777).toBe(0o600);
        expect(statSync(`${logPrefix}.stderr.txt`).mode & 0o777).toBe(0o600);
      } finally {
        removeAllFixtures();
      }
    });
  });

  it("rejects with the log write error, ends the session with SIGTERM and lists no pid", async () => {
    await withScratchFolder(async (scratch) => {
      const pidFile = join(scratch, "pid.txt");
      try {
        const binary = join(scratch, "claude-standin.sh");
        writeExecutable(binary, [
          "#!/bin/sh",
          `echo "$$" > '${pidFile}'`,
          "echo one output line",
          SLEEP_ONE_SECOND_FOR_A_MINUTE,
        ]);
        const logPrefix = join(scratch, "out.txt.agent-poteto.denied");
        const writeError = new Error("disk full");

        await expect(
          runClaudeSession(sessionRequestAt(logPrefix), {
            claudeBinary: binary,
            limitMs: 20_000,
            appendLog: () => {
              throw writeError;
            },
          }),
        ).rejects.toBe(writeError);

        const standInPid = readStandInPid(pidFile);
        if (standInPid === undefined) throw new Error("the stand-in did not write its pid");
        expect(processIsAlive(standInPid)).toBe(false);
        expect(runningSessionPids()).toEqual([]);
      } finally {
        killProcessIfAlive(readStandInPid(pidFile));
        removeAllFixtures();
      }
    });
  }, 15_000);
});

// ---------------------------------------------------------------------------------------------
// The script as a process, with a stand-in for `claude` first on PATH
// ---------------------------------------------------------------------------------------------

const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = join(PRODUCT_ROOT, "scripts/lk/pstack-guard-proof.ts");
const STAND_IN_VERSION = "stand-in 1.0";
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const FIXTURE_PREFIX = "lk-pstack-guard-proof-";

const STAND_IN_VERSION_LINES = [
  "#!/bin/sh",
  'if [ "$1" = "--version" ]; then',
  `  echo "${STAND_IN_VERSION}"`,
  "  exit 0",
  "fi",
];

// Answers from the files that the test wrote: a refusal when the settings text of its working
// directory holds the entry, an allowed call otherwise.
const ANSWERING_STAND_IN_LINES = [
  ...STAND_IN_VERSION_LINES,
  'echo "$$" > "$STAND_IN_FOLDER/pid.txt"',
  'case "$2" in',
  '  *"Agent tool"*) kind=agent ;;',
  "  *) kind=skill ;;",
  "esac",
  "if grep -q 'pstack:' .claude/settings.json; then",
  '  cat "$STAND_IN_FOLDER/$kind-denied.jsonl"',
  "else",
  '  cat "$STAND_IN_FOLDER/$kind-allowed.jsonl"',
  "fi",
];

// Ignores SIGTERM before it writes its pid, so only SIGKILL ends it.
const LOOPING_STAND_IN_LINES = [
  ...STAND_IN_VERSION_LINES,
  "trap '' TERM",
  'echo "$$" > "$STAND_IN_FOLDER/pid.txt"',
  SLEEP_ONE_SECOND_FOR_A_MINUTE,
];

interface ProofProcessLayout {
  binFolder: string;
  homeFolder: string;
  tmpFolder: string;
  standInFolder: string;
  pidFile: string;
  docsFolder: string;
  outPath: string;
}

const prepareProofProcessLayout = (base: string, standInLines: string[]): ProofProcessLayout => {
  const layout: ProofProcessLayout = {
    binFolder: join(base, "bin"),
    homeFolder: join(base, "home"),
    tmpFolder: join(base, "tmp"),
    standInFolder: join(base, "stand-in"),
    pidFile: join(base, "stand-in", "pid.txt"),
    docsFolder: join(base, "docs"),
    outPath: join(base, "out", "out.txt"),
  };
  for (const folder of [
    layout.binFolder,
    layout.homeFolder,
    layout.tmpFolder,
    layout.standInFolder,
    dirname(layout.outPath),
  ]) {
    mkdirSync(folder);
  }
  writeDocsSettings(layout.docsFolder, settingsTextWith([AGENT_ENTRY, SKILL_ENTRY]));
  writeExecutable(join(layout.binFolder, "claude"), standInLines);
  writeFileSync(join(layout.standInFolder, "agent-denied.jsonl"), DENIED_AGENT_LOG);
  writeFileSync(join(layout.standInFolder, "agent-allowed.jsonl"), ALLOWED_AGENT_LOG);
  writeFileSync(join(layout.standInFolder, "skill-denied.jsonl"), DENIED_SKILL_LOG);
  writeFileSync(join(layout.standInFolder, "skill-allowed.jsonl"), ALLOWED_SKILL_LOG);
  return layout;
};

// The copy is for the child only: the test's own environment is never changed.
const proofProcessEnvironment = (
  layout: ProofProcessLayout,
  docsRootValue: string,
): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${layout.binFolder}:${process.env.PATH ?? ""}`,
  HOME: layout.homeFolder,
  TMPDIR: layout.tmpFolder,
  DENY_PROOF_DOCS_ROOT: docsRootValue,
  STAND_IN_FOLDER: layout.standInFolder,
});

// A real `claude` first on PATH would start real sessions, so the test stops before it starts the
// script unless the stand-in answers `--version`.
const expectStandInFirstOnPath = (environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync("claude", ["--version"], { env: environment, encoding: "utf8" });

  expect(result.stdout.trim()).toBe(STAND_IN_VERSION);
};

interface ProofProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProofProcess {
  child: ChildProcess;
  closed: Promise<ProofProcessExit>;
  output: () => { stdout: string; stderr: string };
}

const startProofProcess = (
  layout: ProofProcessLayout,
  environment: NodeJS.ProcessEnv,
): ProofProcess => {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--out", layout.outPath], {
    cwd: PRODUCT_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const closed = new Promise<ProofProcessExit>((resolveClosed) => {
    child.on("close", (code, signal) => resolveClosed({ code, signal }));
  });
  return { child, closed, output: () => ({ stdout, stderr }) };
};

// The script goes first, so it cannot start another stand-in once the last one is killed. The wait
// is bounded because a stand-in that outlives the script keeps the output pipes open.
const stopProofProcess = async (proof: ProofProcess, pidFile: string): Promise<void> => {
  const scriptIsRunning = proof.child.exitCode === null && proof.child.signalCode === null;
  if (scriptIsRunning) proof.child.kill("SIGKILL");
  killProcessIfAlive(readStandInPid(pidFile));
  await Promise.race([proof.closed, sleep(5_000)]);
};

const fixturesLeftIn = (tmpFolder: string): string[] =>
  readdirSync(tmpFolder).filter((name) => name.startsWith(FIXTURE_PREFIX));

describe("the script as a process", () => {
  it(
    "runs the whole proof through the entry point against a stand-in and passes",
    async () => {
      await withScratchFolder(async (base) => {
        const layout = prepareProofProcessLayout(base, ANSWERING_STAND_IN_LINES);
        const environment = proofProcessEnvironment(layout, layout.docsFolder);
        expectStandInFirstOnPath(environment);
        const proof = startProofProcess(layout, environment);
        try {
          const exit = await proof.closed;
          const { stdout, stderr } = proof.output();
          const lines = stdout.trimEnd().split("\n");

          expect(exit, stderr).toEqual({ code: 0, signal: null });
          expect(lines.at(-1)).toBe("pstack-guard-proof PASSED");
          expect(lines).toContain("CASE agent-poteto");
          expect(lines).toContain("CASE skill-setup");
          expect(lines.filter((line) => line === "  verdict: PASS")).toHaveLength(2);
          expect(lines).toContain(`claude: ${STAND_IN_VERSION}`);
          expect(lines).toContain(
            `docs settings: ${join(layout.docsFolder, ".claude/settings.json")}`,
          );
          expect(readFileSync(layout.outPath, "utf8")).toBe(stdout);
          for (const name of [
            "agent-poteto.denied",
            "agent-poteto.control",
            "skill-setup.denied",
            "skill-setup.control",
          ]) {
            expect(existsSync(`${layout.outPath}.${name}.jsonl`), name).toBe(true);
          }
          expect(fixturesLeftIn(layout.tmpFolder)).toEqual([]);
        } finally {
          await stopProofProcess(proof, layout.pidFile);
        }
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "stops, kills and cleans up after a SIGTERM and exits 143",
    async () => {
      await withScratchFolder(async (base) => {
        const layout = prepareProofProcessLayout(base, LOOPING_STAND_IN_LINES);
        const environment = proofProcessEnvironment(layout, layout.docsFolder);
        expectStandInFirstOnPath(environment);
        const proof = startProofProcess(layout, environment);
        try {
          const pidWritten = await pollUntil(
            () => readStandInPid(layout.pidFile) !== undefined,
            20_000,
          );
          const standInPid = readStandInPid(layout.pidFile);
          if (!pidWritten || standInPid === undefined) {
            throw new Error("the stand-in did not write its pid within 20 seconds");
          }

          proof.child.kill("SIGTERM");
          const exit = await proof.closed;
          const { stdout, stderr } = proof.output();
          const lines = stdout.split("\n");

          expect(exit, stderr).toEqual({ code: 143, signal: null });
          expect(lines).toContain("SIGNAL SIGTERM: stopping 1 running session(s)");
          expect(lines).toContain("POSTCHECK after signal: sessions still alive: []");
          expect(lines).toContain("POSTCHECK after signal: fixtures still present: []");
          const standInGone = await pollUntil(() => !processIsAlive(standInPid), 2_000);
          expect(standInGone, "the stand-in survived the signal path").toBe(true);
          expect(fixturesLeftIn(layout.tmpFolder)).toEqual([]);
        } finally {
          await stopProofProcess(proof, layout.pidFile);
        }
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "reads the real docs settings file when DENY_PROOF_DOCS_ROOT is empty",
    async () => {
      await withScratchFolder(async (base) => {
        const layout = prepareProofProcessLayout(base, ANSWERING_STAND_IN_LINES);
        const environment = proofProcessEnvironment(layout, "");
        expectStandInFirstOnPath(environment);
        const proof = startProofProcess(layout, environment);
        try {
          const exit = await proof.closed;
          const { stdout, stderr } = proof.output();
          const lines = stdout.split("\n");

          expect(lines).toContain("docs root override: none");
          expect(lines).toContain(
            `docs settings: ${join(PRODUCT_ROOT, "docs/.claude/settings.json")}`,
          );
          expect(exit, stderr).toEqual({ code: 0, signal: null });
        } finally {
          await stopProofProcess(proof, layout.pidFile);
        }
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// The real docs file, read through process.cwd() as the command reads it
// ---------------------------------------------------------------------------------------------

describe("the real docs settings file", () => {
  it("holds both deny entries of the proof", () => {
    const entries = PROOF_CASES.map((testCase) => testCase.entry);
    const docsRoot = resolve(process.cwd(), "docs");
    let settingsPath: string;
    try {
      settingsPath = readDocsEntries(docsRoot, entries);
    } catch (error) {
      if (
        error instanceof LkRefusal &&
        error.message.startsWith("docs settings file is unreadable")
      ) {
        throw new Error(
          "docs/.claude/settings.json is not readable: the docs checkout is not present here.",
        );
      }
      throw error;
    }

    expect(settingsPath).toBe(join(docsRoot, ".claude/settings.json"));
    const parsed: { permissions: { deny: string[] } } = JSON.parse(
      readFileSync(settingsPath, "utf8"),
    );
    expect(parsed.permissions.deny).toEqual(expect.arrayContaining(entries));
  });
});
