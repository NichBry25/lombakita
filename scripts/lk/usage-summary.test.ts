// @vitest-environment node

/**
 * The usage summary, run as a process over a throwaway work folder.
 *
 * Each test asserts the whole printed output and the status. A refusal test asserts an empty stdout,
 * the first stderr line and status 1. Fixtures live in a temporary folder that is removed in a
 * `finally`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SLUG = "s";
const WORK = `.work/${SLUG}`;
const HEADER = ["date", "role", "label", "tokens", "tool_uses", "duration_ms"].join("\t");

const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;
const scriptPath = join(process.cwd(), "scripts/lk/usage-summary.ts");

const runUsage = (cwd: string, slug: string) =>
  spawnSync("node", ["--import", tsxLoader, scriptPath, slug], { cwd, encoding: "utf8" });

interface UsageFixture {
  /** Default true. False leaves the work folder out. */
  workFolder?: boolean;
  /** The slug the script is run with. Default is the slug the work folder is made for. */
  runSlug?: string;
  sessionLog?: string;
  usageFile?: string;
}

const runFixture = (fixture: UsageFixture = {}) => {
  const folder = mkdtempSync(join(tmpdir(), "lk-usage-summary-"));
  try {
    writeFileSync(join(folder, "package.json"), "{}");
    if (fixture.workFolder !== false) mkdirSync(join(folder, WORK), { recursive: true });
    if (fixture.sessionLog !== undefined) {
      writeFileSync(join(folder, WORK, "session.jsonl"), fixture.sessionLog);
    }
    if (fixture.usageFile !== undefined) {
      writeFileSync(join(folder, WORK, "usage.tsv"), fixture.usageFile);
    }
    return runUsage(folder, fixture.runSlug ?? SLUG);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const stdoutLines = (stdout: string): string[] => stdout.trimEnd().split("\n");

const firstStderrLine = (stderr: string): string => stderr.split("\n")[0] ?? "";

const tabRow = (...fields: string[]): string => fields.join("\t");

const usageFileOf = (...rows: string[]): string => [HEADER, ...rows].join("\n") + "\n";

const expectRefusal = (fixture: UsageFixture, refusalLine: string): void => {
  const result = runFixture(fixture);
  expect(result.stdout).toBe("");
  expect(firstStderrLine(result.stderr)).toBe(refusalLine);
  expect(result.status).toBe(1);
};

const sonnetUsage = (usage: Record<string, number>) => ({ "claude-sonnet-5-5": usage });

const SESSION_LOG = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "aaaaaaaa-1111" }),
  JSON.stringify({
    type: "result",
    session_id: "aaaaaaaa-1111",
    result_index: 0,
    duration_ms: 60000,
    num_turns: 5,
    total_cost_usd: 1.5,
    model_usage_since_last_result: sonnetUsage({
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 50,
      costUSD: 1.5,
    }),
  }),
  JSON.stringify({
    type: "result",
    session_id: "aaaaaaaa-1111",
    result_index: 1,
    duration_ms: 30000,
    num_turns: 1,
    total_cost_usd: 1.75,
    model_usage_since_last_result: sonnetUsage({
      inputTokens: 2,
      outputTokens: 20,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 0,
      costUSD: 0.25,
    }),
  }),
  JSON.stringify({
    type: "result",
    session_id: "bbbbbbbb-2222",
    result_index: 0,
    duration_ms: 6000,
    num_turns: 2,
    total_cost_usd: 0,
    model_usage_since_last_result: {},
  }),
  '{"type":"res',
].join("\n");

describe("the usage summary", () => {
  it("sums every result segment of a session and keeps sessions apart", () => {
    const result = runFixture({
      sessionLog: SESSION_LOG,
      usageFile: usageFileOf(
        tabRow("2026-11-26", "review-a", "Review A", "141138", "13", "81851"),
        tabRow("2026-11-26", "prompt-review", "Part 1", "50000", "7", "120000"),
        tabRow("2026-11-26", "review-a", "re-run", "10000", "2", "60000"),
      ),
    });
    expect(stdoutLines(result.stdout)).toEqual([
      "lk-usage s",
      "implementer: 2 sessions, 8 turns, 1.6 minutes, output 120 tokens, input 12, cache read 1200, cache write 50, cost $1.75 at list price",
      "implementer session aaaaaaaa: 2 results, 6 turns, 1.5 minutes, output 120 tokens, cost $1.75",
      "implementer session bbbbbbbb: 1 results, 2 turns, 0.1 minutes, output 0 tokens, cost $0.00",
      "subagent prompt-review: 1 sessions, 50000 tokens, 7 tool uses, 2.0 minutes",
      "subagent review-a: 2 sessions, 151138 tokens, 15 tool uses, 2.4 minutes",
      "subagent total: 3 sessions, 201138 tokens, 22 tool uses, 4.4 minutes",
      "controller: not measured",
      "unparsed session log lines: 1",
      "results without usage data: 0",
    ]);
    expect(result.status).toBe(0);
  });

  it("prints the absent-file lines when neither file exists", () => {
    const result = runFixture();
    expect(stdoutLines(result.stdout)).toEqual([
      "lk-usage s",
      `implementer: no session log at ${WORK}/session.jsonl`,
      `subagent: no usage file at ${WORK}/usage.tsv`,
      "controller: not measured",
    ]);
    expect(result.status).toBe(0);
  });

  it("counts a result event in the older log format", () => {
    const olderFormatEvent = JSON.stringify({
      type: "result",
      session_id: "cccccccc-3333",
      duration_ms: 60000,
      num_turns: 3,
      total_cost_usd: 0.69,
      modelUsage: { "claude-sonnet-5-5": { outputTokens: 10, costUSD: 0.69 } },
    });
    const result = runFixture({ sessionLog: [olderFormatEvent, "null"].join("\n") });
    expect(stdoutLines(result.stdout)).toEqual([
      "lk-usage s",
      "implementer: 1 sessions, 3 turns, 1.0 minutes, output 0 tokens, input 0, cache read 0, cache write 0, cost $0.00 at list price",
      "implementer session cccccccc: 1 results, 3 turns, 1.0 minutes, output 0 tokens, cost $0.00",
      `subagent: no usage file at ${WORK}/usage.tsv`,
      "controller: not measured",
      "unparsed session log lines: 1",
      "results without usage data: 1",
    ]);
    expect(result.status).toBe(0);
  });

  it("counts a usage field that is not a number", () => {
    const stringCostEvent = JSON.stringify({
      type: "result",
      session_id: "dddddddd-4444",
      duration_ms: 60000,
      num_turns: 1,
      model_usage_since_last_result: {
        "claude-sonnet-5-5": { outputTokens: 5, costUSD: "2.0" },
      },
    });
    const result = runFixture({ sessionLog: stringCostEvent });
    expect(stdoutLines(result.stdout)).toEqual([
      "lk-usage s",
      "implementer: 1 sessions, 1 turns, 1.0 minutes, output 0 tokens, input 0, cache read 0, cache write 0, cost $0.00 at list price",
      "implementer session dddddddd: 1 results, 1 turns, 1.0 minutes, output 0 tokens, cost $0.00",
      `subagent: no usage file at ${WORK}/usage.tsv`,
      "controller: not measured",
      "unparsed session log lines: 0",
      "results without usage data: 1",
    ]);
    expect(result.status).toBe(0);
  });
});

describe("the usage summary refusals", () => {
  it("refuses an unknown role in the usage file", () => {
    expectRefusal(
      { usageFile: usageFileOf(tabRow("2026-11-26", "reviewer", "x", "1", "1", "1")) },
      `LK REFUSED: ${WORK}/usage.tsv line 2: unknown role "reviewer"`,
    );
  });

  it("refuses a usage file with the wrong header", () => {
    expectRefusal(
      { usageFile: tabRow("date", "role", "tokens") + "\n" },
      `LK REFUSED: ${WORK}/usage.tsv line 1: the header must be date, role, label, tokens, tool_uses and duration_ms separated by tabs`,
    );
  });

  it("refuses a token count that is not a non-negative integer", () => {
    expectRefusal(
      { usageFile: usageFileOf(tabRow("2026-11-26", "review-a", "x", "12.5", "1", "1")) },
      `LK REFUSED: ${WORK}/usage.tsv line 2: tokens "12.5" is not a non-negative integer`,
    );
  });

  it("refuses a missing work folder", () => {
    expectRefusal({ workFolder: false }, `LK REFUSED: no work folder at ${WORK}`);
  });

  it("refuses a slug that leaves the work folder", () => {
    expectRefusal(
      { runSlug: ".." },
      'LK REFUSED: the slug ".." is not lowercase letters, digits and hyphens',
    );
  });

  it("refuses a usage row with the wrong field count", () => {
    expectRefusal(
      { usageFile: usageFileOf(tabRow("2026-11-26", "review-a", "x", "1", "1")) },
      `LK REFUSED: ${WORK}/usage.tsv line 2: expected 6 tab-separated fields, found 5`,
    );
  });
});
