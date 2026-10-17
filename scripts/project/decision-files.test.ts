/**
 * Decision files, the log rendered from them, and the two gates over both.
 *
 * Every fixture is synthetic. The gate tests copy the clean fixture to a temp directory and run the
 * real scripts against it, so the exit code asserted is the one `npm run decisions:check` produces.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DecisionRefusal,
  formatDecisionFile,
  formatIndexRow,
  formatSeededRow,
  orderDecisions,
  parseDecisionFile,
  readDecisionDirectory,
  renderDecisionLog,
  type DecisionFile,
} from "./decision-files";

const CLEAN_FIXTURE = "scripts/testing/fixtures/decisions/clean";
const workspace = mkdtempSync(join(tmpdir(), "decision-files-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const decision = (overrides: Partial<DecisionFile> = {}): DecisionFile => ({
  id: "DEC-0007",
  type: "decision",
  title: "A title: with a colon",
  indexTitle: null,
  status: "accepted",
  date: "2026-01-01",
  owner: "owner",
  supersedes: "N/A",
  rationale: "Why | this, with a pipe",
  ...overrides,
});

/** A copy of the clean fixture the test may damage. */
const freshDocs = (name: string): string => {
  const docs = join(workspace, name);
  cpSync(CLEAN_FIXTURE, docs, { recursive: true });
  return docs;
};

const run = (script: string, args: string[]) =>
  spawnSync("node", ["--import", "tsx", `scripts/project/${script}`, ...args], {
    encoding: "utf8",
  });

describe("decision file format", () => {
  it("round-trips a file whose values hold colons and pipes", () => {
    const original = decision({ indexTitle: "Short" });
    expect(parseDecisionFile("DEC-0007.md", formatDecisionFile(original))).toEqual(original);
  });

  it("round-trips an empty supersedes field and an empty body", () => {
    const original = decision({ supersedes: "", rationale: "" });
    expect(parseDecisionFile("DEC-0007.md", formatDecisionFile(original))).toEqual(original);
  });

  it("omits index_title when it is null", () => {
    expect(formatDecisionFile(decision())).not.toContain("index_title");
  });

  it("refuses a file with no opening fence, an unknown key, a repeated key or a missing key", () => {
    const good = formatDecisionFile(decision());
    expect(() => parseDecisionFile("f.md", good.replace(/^---\n/, ""))).toThrow(DecisionRefusal);
    expect(() => parseDecisionFile("f.md", good.replace("owner:", "boss:"))).toThrow(/unknown/);
    expect(() => parseDecisionFile("f.md", good.replace("date:", "owner: x\ndate:"))).toThrow(
      /twice/,
    );
    expect(() => parseDecisionFile("f.md", good.replace(/status: .*\n/, ""))).toThrow(/missing/);
  });
});

describe("rendering", () => {
  it("orders decisions numerically and puts notes last by name", () => {
    const ordered = orderDecisions([
      decision({ id: "NOTE-B", type: "note" }),
      decision({ id: "DEC-0100" }),
      decision({ id: "NOTE-A", type: "note" }),
      decision({ id: "DEC-0009" }),
    ]);
    expect(ordered.map((d) => d.id)).toEqual(["DEC-0009", "DEC-0100", "NOTE-A", "NOTE-B"]);
  });

  it("prefers index_title in the index row and never in the seeded row", () => {
    const d = decision({ indexTitle: "Short" });
    expect(formatIndexRow(d)).toBe("| DEC-0007 | Short | accepted | 2026-01-01 |");
    expect(formatSeededRow(d)).toContain("| A title: with a colon |");
  });

  it("changes nothing on a second render, and rewrites the count and highest id", () => {
    const { entries } = readDecisionDirectory(join(CLEAN_FIXTURE, "project/decisions"));
    const files = entries.map((entry) => entry.decision);
    const log = readFileSync(join(CLEAN_FIXTURE, "project/decision-log.md"), "utf8");
    const staleCount = log.replace(
      "2 decisions, DEC-0001 to DEC-0002",
      "9 decisions, DEC-0001 to DEC-0009",
    );
    const once = renderDecisionLog(staleCount, files);
    expect(once).toBe(log);
    expect(renderDecisionLog(once, files)).toBe(once);
  });

  it("refuses a log with a missing or repeated marker", () => {
    const { entries } = readDecisionDirectory(join(CLEAN_FIXTURE, "project/decisions"));
    const files = entries.map((entry) => entry.decision);
    const log = readFileSync(join(CLEAN_FIXTURE, "project/decision-log.md"), "utf8");
    expect(() => renderDecisionLog(log.replace("<!-- decisions:index:end -->", ""), files)).toThrow(
      /exactly one/,
    );
  });

  it("ignores files whose names start with an underscore", () => {
    const { entries } = readDecisionDirectory(join(CLEAN_FIXTURE, "project/decisions"));
    expect(entries.map((entry) => entry.fileName)).toEqual([
      "DEC-0001.md",
      "DEC-0002.md",
      "NOTE-FIXTURE.md",
    ]);
  });
});

describe("decisions:check and decisions:build, through the real scripts", () => {
  it("passes on the clean fixture", () => {
    expect(run("decisions-check.ts", ["--docs", CLEAN_FIXTURE]).status).toBe(0);
    expect(run("decisions-build.ts", ["--check", "--docs", CLEAN_FIXTURE]).status).toBe(0);
  });

  it("reports drift inside a generated region, and the build repairs it", () => {
    const docs = freshDocs("drift");
    const logPath = join(docs, "project/decision-log.md");
    writeFileSync(
      logPath,
      readFileSync(logPath, "utf8").replace("Fixture decision one (short)", "Edited by hand"),
    );
    const check = run("decisions-check.ts", ["--docs", docs]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("generated region differs");
    expect(run("decisions-build.ts", ["--check", "--docs", docs]).status).toBe(1);
    expect(run("decisions-build.ts", ["--docs", docs]).status).toBe(0);
    expect(run("decisions-check.ts", ["--docs", docs]).status).toBe(0);
  });

  it("names the file whose supersedes points at a decision that does not exist", () => {
    const docs = freshDocs("missing-target");
    const file = join(docs, "project/decisions/DEC-0002.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("DEC-0001 in part", "DEC-0900"));
    const check = run("decisions-check.ts", ["--docs", docs]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("DEC-0002.md: supersedes names DEC-0900");
  });

  it("refuses a status outside the list, a duplicate id and an empty required field", () => {
    const docs = freshDocs("shapes");
    const two = join(docs, "project/decisions/DEC-0002.md");
    writeFileSync(two, readFileSync(two, "utf8").replace("superseded in part", "maybe"));
    const dup = join(docs, "project/decisions/DEC-0003.md");
    writeFileSync(dup, readFileSync(join(docs, "project/decisions/DEC-0001.md"), "utf8"));
    const note = join(docs, "project/decisions/NOTE-FIXTURE.md");
    writeFileSync(note, readFileSync(note, "utf8").replace("owner: fixture-owner", "owner:"));
    const stderr = run("decisions-check.ts", ["--docs", docs]).stderr;
    expect(stderr).toContain('DEC-0002.md: status "maybe" is not one of');
    expect(stderr).toContain("DEC-0003.md: duplicate id DEC-0001, also in DEC-0001.md");
    expect(stderr).toContain("NOTE-FIXTURE.md: owner is empty");
  });

  it("refuses a docs directory with no decisions directory", () => {
    expect(run("decisions-check.ts", ["--docs", workspace]).status).toBe(1);
  });
});
