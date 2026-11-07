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
import { EFFORT_LEVELS, LkRefusal, modelForClass, readModels, resolveJob } from "./models";

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

/** 1-based number of the first line of `whole` that equals `text`, the way a refusal names it. */
const lineIn = (whole: string, text: string): number => whole.split("\n").indexOf(text) + 1;

/** 1-based number of the first fixture line that equals `text`, the way a refusal names it. */
const lineOf = (text: string): number => lineIn(fixtureText, text);

/** Every line number a refusal pattern names; a row text the fixture lacks shows up as 0. */
const lineNumbersIn = (message: RegExp): number[] =>
  [...message.source.matchAll(/line (\d+)/g)].map((match) => Number(match[1]));

const CLASS_TABLE = [
  "| Class | Model | Effort |",
  "|---|---|---|",
  "| Heavy | claude-test-heavy | max |",
  "| Standard | claude-test-standard | |",
  "| Light | claude-test-light | low |",
].join("\n");

const TWO_COLUMN_CLASS_TABLE = [
  "| Class | Model |",
  "|---|---|",
  "| Heavy | claude-test-heavy |",
  "| Standard | claude-test-standard |",
  "| Light | claude-test-light |",
].join("\n");

const toTwoColumnClassTable = (text: string): string =>
  text.replace(CLASS_TABLE, TWO_COLUMN_CLASS_TABLE);

const twoColumnText = toTwoColumnClassTable(fixtureText);

const classTableCount = (found: number): RegExp =>
  new RegExp(
    `: expected exactly one class table headed "\\| Class \\| Model \\| Effort \\|" or "\\| Class \\| Model \\|", found ${found}$`,
  );

const effortRefusal = (row: string, value: string): RegExp =>
  new RegExp(
    `line ${lineOf(row)}: effort must be empty or one of low, medium, high, xhigh, max, not "${value}"$`,
  );

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

  it("reads the effort of each class, an empty cell as default", () => {
    expect(readModels(FIXTURE).efforts).toEqual({
      Heavy: "max",
      Standard: "default",
      Light: "low",
    });
  });

  it.each(EFFORT_LEVELS)("reads the effort %s from a cell", (level) => {
    const text = fixtureText.replace(
      "| Standard | claude-test-standard | |",
      `| Standard | claude-test-standard | ${level} |`,
    );
    expect(text).not.toBe(fixtureText);
    expect(readModels(writeTable(text)).efforts.Standard).toBe(level);
  });

  it("reads a two-column class table with every effort default", () => {
    expect(twoColumnText).not.toBe(fixtureText);
    const table = readModels(writeTable(twoColumnText));
    expect(table.models).toEqual({
      Heavy: "claude-test-heavy",
      Standard: "claude-test-standard",
      Light: "claude-test-light",
    });
    expect(table.efforts).toEqual({ Heavy: "default", Standard: "default", Light: "default" });
    expect(table.jobs).toHaveLength(6);
  });

  it.each([
    {
      name: "a class table header that is not exact",
      damage: (text: string) => text.replace("| Class | Model |", "| Class | Name |"),
      message: classTableCount(0),
    },
    {
      name: "a job table header that is not exact",
      damage: (text: string) => text.replace("| Job | Tier | Class |", "| Job | Level | Class |"),
      message: /expected exactly one table headed "\| Job \| Tier \| Class \|", found 0/,
    },
    {
      name: "a repeated class table",
      damage: (text: string) => `${text}\n| Class | Model | Effort |\n|---|---|---|\n`,
      message: classTableCount(2),
    },
    {
      name: "a file holding both class table heads",
      damage: (text: string) => `${text}\n| Class | Model |\n|---|---|\n`,
      message: classTableCount(2),
    },
    {
      name: "a file holding no class table",
      damage: (text: string) => text.replace(`${CLASS_TABLE}\n`, ""),
      message: classTableCount(0),
    },
    {
      name: "a class delimiter row that is not exact",
      damage: (text: string) =>
        text.replace(
          "| Class | Model | Effort |\n|---|---|---|\n",
          "| Class | Model | Effort |\n| --- | --- | --- |\n",
        ),
      message: new RegExp(
        `line ${lineOf("| Class | Model | Effort |") + 1}: expected the delimiter row "\\|---\\|---\\|---\\|"$`,
      ),
    },
    {
      name: "a two-column class table whose delimiter row is not exact",
      damage: (text: string) =>
        toTwoColumnClassTable(text).replace(
          "| Class | Model |\n|---|---|\n",
          "| Class | Model |\n|---|---|---|\n",
        ),
      message: new RegExp(
        `line ${lineIn(twoColumnText, "| Class | Model |") + 1}: expected the delimiter row "\\|---\\|---\\|"$`,
      ),
    },
    {
      name: "a job delimiter row that is not exact",
      damage: (text: string) =>
        text.replace(
          "| Job | Tier | Class |\n|---|---|---|\n",
          "| Job | Tier | Class |\n|---|---|\n",
        ),
      message: new RegExp(
        `line ${lineOf("| Job | Tier | Class |") + 1}: expected the delimiter row`,
      ),
    },
    {
      name: "an unknown class in the class table",
      damage: (text: string) =>
        text.replace("| Light | claude-test-light | low |", "| Tiny | claude-test-light | low |"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light | low |")}: unknown class "Tiny"`,
      ),
    },
    {
      name: "a model id that is not a claude id",
      damage: (text: string) => text.replace("claude-test-light", "Claude_Light"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light | low |")}: "Claude_Light" is not a model id`,
      ),
    },
    {
      name: "a row whose model id and effort are both wrong, for the model id",
      damage: (text: string) =>
        text.replace("| Light | claude-test-light | low |", "| Light | Claude_Light | ultra |"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light | low |")}: "Claude_Light" is not a model id`,
      ),
    },
    {
      name: "an effort written with a capital letter",
      damage: (text: string) =>
        text.replace("| Heavy | claude-test-heavy | max |", "| Heavy | claude-test-heavy | Max |"),
      message: effortRefusal("| Heavy | claude-test-heavy | max |", "Max"),
    },
    {
      name: "an effort that is not one of the five",
      damage: (text: string) =>
        text.replace(
          "| Heavy | claude-test-heavy | max |",
          "| Heavy | claude-test-heavy | ultra |",
        ),
      message: effortRefusal("| Heavy | claude-test-heavy | max |", "ultra"),
    },
    {
      name: "an effort cell holding the word default",
      damage: (text: string) =>
        text.replace(
          "| Standard | claude-test-standard | |",
          "| Standard | claude-test-standard | default |",
        ),
      message: effortRefusal("| Standard | claude-test-standard | |", "default"),
    },
    {
      name: "a class listed twice",
      damage: (text: string) =>
        text.replace("| Light | claude-test-light | low |", "| Heavy | claude-test-light | low |"),
      message: new RegExp(
        `line ${lineOf("| Light | claude-test-light | low |")}: class Heavy is listed twice`,
      ),
    },
    {
      name: "a class that is missing",
      damage: (text: string) => text.replace("| Light | claude-test-light | low |\n", ""),
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
    const damaged = damage(fixtureText);
    expect(damaged).not.toBe(fixtureText);
    for (const line of lineNumbersIn(message)) expect(line).toBeGreaterThan(0);
    const path = writeTable(damaged);
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
      effort: "low",
    });
    expect(resolveJob(table, "implement", "1")).toEqual({
      class: "Standard",
      model: "claude-test-standard",
      effort: "default",
    });
  });

  it("falls back to the row for tier any when no exact row exists", () => {
    expect(resolveJob(table, "implement", "2")).toEqual({
      class: "Standard",
      model: "claude-test-standard",
      effort: "default",
    });
    expect(resolveJob(table, "lookup", "3")).toEqual({
      class: "Light",
      model: "claude-test-light",
      effort: "low",
    });
  });

  it("returns the effort of the class the job resolves to", () => {
    expect(resolveJob(table, "review", "1")).toEqual({
      class: "Heavy",
      model: "claude-test-heavy",
      effort: "max",
    });
    expect(resolveJob(table, "implement", "2").effort).toBe("default");
    expect(resolveJob(table, "lookup", "1").effort).toBe("low");
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
    expect(JSON.parse(byClass.stdout)).toEqual({
      class: "Light",
      model: "claude-test-light",
      effort: "low",
    });
    const byJob = cli(["--file", FIXTURE, "--job", "review", "--tier", "1", "--json"]);
    expect(JSON.parse(byJob.stdout)).toEqual({
      job: "review",
      tier: "1",
      class: "Heavy",
      model: "claude-test-heavy",
      effort: "max",
    });
  });

  it("puts the effort directly after the model in both JSON outputs", () => {
    const byClass = cli(["--file", FIXTURE, "--class", "Heavy", "--json"]);
    expect(byClass.stdout).toBe('{"class":"Heavy","model":"claude-test-heavy","effort":"max"}\n');
    const byJob = cli(["--file", FIXTURE, "--job", "implement", "--tier", "2", "--json"]);
    expect(byJob.stdout).toBe(
      '{"job":"implement","tier":"2","class":"Standard","model":"claude-test-standard","effort":"default"}\n',
    );
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
    expect(result.stderr).toContain(
      `${path} line ${lineOf("| Light | claude-test-light | low |")}`,
    );
  });
});
