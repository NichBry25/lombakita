// @vitest-environment node

/**
 * The model table reader and its CLI.
 *
 * The fixture is synthetic. A refusal case is the fixture with one line damaged, written to a temp
 * directory, so the line number asserted is the line the reader actually names.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LkRefusal, modelForClass, readModels, resolveJob } from "./models";

const FIXTURE = "scripts/testing/fixtures/lk/models.md";
const fixtureText = readFileSync(FIXTURE, "utf8");
const workspace = mkdtempSync(join(tmpdir(), "lk-models-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let written = 0;
const writeTable = (text: string): string => {
  written += 1;
  const path = join(workspace, `models-${written}.md`);
  writeFileSync(path, text);
  return path;
};

/** 1-based number of the first fixture line that equals `text`, the way a refusal names it. */
const lineOf = (text: string): number => fixtureText.split("\n").indexOf(text) + 1;

const cli = (args: string[]) =>
  spawnSync("node", ["--import", "tsx", "scripts/lk/models.ts", ...args], { encoding: "utf8" });

describe("reading the table", () => {
  it("reads the three classes and the job rows", () => {
    const table = readModels(FIXTURE);
    expect(table.models).toEqual({
      Heavy: "claude-test-heavy",
      Standard: "claude-test-standard",
      Light: "claude-test-light",
    });
    expect(table.jobs).toHaveLength(6);
    expect(modelForClass(table, "Light")).toBe("claude-test-light");
  });

  it.each([
    {
      name: "a class table header that is not exact",
      damage: (text: string) => text.replace("| Class | Model |", "| Class | Name |"),
      message: /expected exactly one table headed "\| Class \| Model \|", found 0/,
    },
    {
      name: "a job table header that is not exact",
      damage: (text: string) => text.replace("| Job | Tier | Class |", "| Job | Level | Class |"),
      message: /expected exactly one table headed "\| Job \| Tier \| Class \|", found 0/,
    },
    {
      name: "a repeated class table",
      damage: (text: string) => `${text}\n| Class | Model |\n|---|---|\n`,
      message: /expected exactly one table headed "\| Class \| Model \|", found 2/,
    },
    {
      name: "a class delimiter row that is not exact",
      damage: (text: string) => text.replace("|---|---|\n", "| --- | --- |\n"),
      message: new RegExp(`line ${lineOf("|---|---|")}: expected the delimiter row`),
    },
    {
      name: "a job delimiter row that is not exact",
      damage: (text: string) => text.replace("|---|---|---|\n", "|---|---|\n"),
      message: new RegExp(`line ${lineOf("|---|---|---|")}: expected the delimiter row`),
    },
    {
      name: "an unknown class in the class table",
      damage: (text: string) =>
        text.replace("| Light | claude-test-light |", "| Tiny | claude-test-light |"),
      message: new RegExp(`line ${lineOf("| Light | claude-test-light |")}: unknown class "Tiny"`),
    },
    {
      name: "a model id that is not a claude id",
      damage: (text: string) => text.replace("claude-test-light", "Claude_Light"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light |")}: "Claude_Light" is not a model id`,
      ),
    },
    {
      name: "a class listed twice",
      damage: (text: string) =>
        text.replace("| Light | claude-test-light |", "| Heavy | claude-test-light |"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light |")}: class Heavy is listed twice`,
      ),
    },
    {
      name: "a class that is missing",
      damage: (text: string) => text.replace("| Light | claude-test-light |\n", ""),
      message: /class Light is missing from the Classes table/,
    },
    {
      name: "an unknown job",
      damage: (text: string) =>
        text.replace("| lookup | any | Light |", "| search | any | Light |"),
      message: new RegExp(`line ${lineOf("| lookup | any | Light |")}: unknown job "search"`),
    },
    {
      name: "a tier that is not 1, 2, 3 or any",
      damage: (text: string) => text.replace("| review | 1 | Heavy |", "| review | 4 | Heavy |"),
      message: new RegExp(
        `line ${lineOf("| review | 1 | Heavy |")}: tier must be 1, 2, 3 or any, not "4"`,
      ),
    },
    {
      name: "an unknown class in the job table",
      damage: (text: string) => text.replace("| review | 1 | Heavy |", "| review | 1 | Huge |"),
      message: new RegExp(`line ${lineOf("| review | 1 | Heavy |")}: unknown class "Huge"`),
    },
    {
      name: "a job and tier listed twice",
      damage: (text: string) =>
        text.replace("| implement | 3 | Light |", "| implement | 1 | Light |"),
      message: new RegExp(
        `line ${lineOf("| implement | 3 | Light |")}: job implement tier 1 is listed twice`,
      ),
    },
    {
      name: "a row with the wrong number of cells",
      damage: (text: string) => text.replace("| review | 1 | Heavy |", "| review | Heavy |"),
      message: new RegExp(`line ${lineOf("| review | 1 | Heavy |")}: expected 3 cells, found 2`),
    },
    {
      name: "a row that does not end with a pipe",
      damage: (text: string) => text.replace("| review | 1 | Heavy |", "| review | 1 | Heavy"),
      message: new RegExp(`line ${lineOf("| review | 1 | Heavy |")}: row does not end with`),
    },
  ])("refuses $name", ({ damage, message }) => {
    const path = writeTable(damage(fixtureText));
    expect(() => readModels(path)).toThrow(LkRefusal);
    expect(() => readModels(path)).toThrow(message);
  });

  it("refuses a file that cannot be read", () => {
    expect(() => readModels(join(workspace, "absent.md"))).toThrow(/cannot read the model table/);
  });
});

describe("resolving a job", () => {
  const table = readModels(FIXTURE);

  it("uses the row for the exact tier when there is one", () => {
    expect(resolveJob(table, "implement", "3")).toEqual({
      class: "Light",
      model: "claude-test-light",
    });
    expect(resolveJob(table, "implement", "1")).toEqual({
      class: "Standard",
      model: "claude-test-standard",
    });
  });

  it("falls back to the row for tier any when no exact row exists", () => {
    expect(resolveJob(table, "implement", "2")).toEqual({
      class: "Standard",
      model: "claude-test-standard",
    });
    expect(resolveJob(table, "lookup", "3")).toEqual({
      class: "Light",
      model: "claude-test-light",
    });
  });

  it("refuses a job and tier with no row and no any row", () => {
    expect(() => resolveJob(table, "review", "2")).toThrow("no class for job review tier 2");
    expect(() => resolveJob(table, "close", "1")).toThrow("no class for job close tier 1");
  });
});

describe("the command line", () => {
  it("prints the model of a class", () => {
    const result = cli(["--file", FIXTURE, "--class", "Heavy"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("claude-test-heavy\n");
  });

  it("prints the class and model of a job at a tier", () => {
    const result = cli(["--file", FIXTURE, "--job", "implement", "--tier", "2"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Standard claude-test-standard\n");
  });

  it("prints an object with --json", () => {
    const byClass = cli(["--file", FIXTURE, "--class", "Light", "--json"]);
    expect(JSON.parse(byClass.stdout)).toEqual({ class: "Light", model: "claude-test-light" });
    const byJob = cli(["--file", FIXTURE, "--job", "review", "--tier", "1", "--json"]);
    expect(JSON.parse(byJob.stdout)).toEqual({
      job: "review",
      tier: "1",
      class: "Heavy",
      model: "claude-test-heavy",
    });
  });

  it.each([
    {
      name: "no job and tier match",
      args: ["--job", "review", "--tier", "2"],
      message: "LK REFUSED: no class for job review tier 2",
    },
    {
      name: "an unknown class",
      args: ["--class", "Huge"],
      message: 'LK REFUSED: unknown class "Huge"',
    },
    {
      name: "tier any as a request",
      args: ["--job", "lookup", "--tier", "any"],
      message: 'LK REFUSED: tier must be 1, 2 or 3, not "any"',
    },
    {
      name: "a job without a tier",
      args: ["--job", "lookup"],
      message: "LK REFUSED: give --class, or --job with --tier",
    },
    {
      name: "no query at all",
      args: [],
      message: "LK REFUSED: give --class, or --job with --tier",
    },
    {
      name: "a class together with a job",
      args: ["--class", "Heavy", "--job", "lookup", "--tier", "1"],
      message: "LK REFUSED: give --class or --job with --tier, not both",
    },
    {
      name: "a positional argument",
      args: ["Heavy"],
      message: 'LK REFUSED: unexpected argument "Heavy"',
    },
  ])("refuses $name in one line and exits 1", ({ args, message }) => {
    const result = cli(["--file", FIXTURE, ...args]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${message}\n`);
  });

  it("refuses an unknown option", () => {
    const result = cli(["--file", FIXTURE, "--class", "Heavy", "--verbose"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^LK REFUSED: Unknown option '--verbose'/);
  });

  it("names the damaged line of a table it refuses", () => {
    const path = writeTable(fixtureText.replace("claude-test-light", "Claude_Light"));
    const result = cli(["--file", path, "--class", "Heavy"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path} line ${lineOf("| Light | claude-test-light |")}`);
  });
});
