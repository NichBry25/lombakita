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
import { orphanedDecisionRows } from "./register-census";
import {
  DecisionRefusal,
  docsDirectory,
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

/** Damages one file of a fresh copy of the clean fixture, runs the check, and returns what it printed. */
const checkAfterDamage = (name: string, file: string, from: string, to: string) => {
  const docs = freshDocs(name);
  const path = join(docs, file);
  const text = readFileSync(path, "utf8");
  expect(text, `${file} does not contain the text this test damages`).toContain(from);
  writeFileSync(path, text.replace(from, to));
  const result = run("decisions-check.ts", ["--docs", docs]);
  return { status: result.status, stderr: result.stderr };
};

describe("each decisions:check rule fails when its input is damaged", () => {
  const one = "project/decisions/DEC-0001.md";
  const note = "project/decisions/NOTE-FIXTURE.md";

  it("refuses an id that differs from the file name", () => {
    const { stderr } = checkAfterDamage("id", one, "id: DEC-0001", "id: DEC-0005");
    expect(stderr).toContain('DEC-0001.md: id "DEC-0005" does not equal the file name');
  });

  it("refuses a type that is neither decision nor note", () => {
    const { stderr } = checkAfterDamage("type", one, "type: decision", "type: Decision");
    expect(stderr).toContain('DEC-0001.md: type "Decision" is not decision or note');
  });

  it("refuses a decision without a DEC id and a note without a NOTE id", () => {
    const decision = checkAfterDamage("decision-id", note, "type: note", "type: decision");
    expect(decision.stderr).toContain("NOTE-FIXTURE.md: a decision needs a DEC-dddd id");
    const asNote = checkAfterDamage("note-id", one, "type: decision", "type: note");
    expect(asNote.stderr).toContain("DEC-0001.md: a note needs a NOTE- id");
  });

  it("allows status note only on a note, and only status note on a note", () => {
    const decision = checkAfterDamage("status-note", one, "status: accepted", "status: note");
    expect(decision.stderr).toContain('DEC-0001.md: status "note" is not one of: accepted');
    const asNote = checkAfterDamage("note-status", note, "status: note", "status: accepted");
    expect(asNote.stderr).toContain('NOTE-FIXTURE.md: status "accepted" is not one of: note');
  });

  it.each(["title", "status", "date", "owner"])("refuses an empty %s", (field) => {
    const { stderr } = checkAfterDamage(
      `empty-${field}`,
      one,
      new RegExp(`${field}: .*\n`).exec(readFileSync(join(CLEAN_FIXTURE, one), "utf8"))?.[0] ?? "",
      `${field}:\n`,
    );
    expect(stderr).toContain(`DEC-0001.md: ${field} is empty`);
  });

  it("refuses an empty type", () => {
    const { stderr } = checkAfterDamage("empty-type", one, "type: decision", "type:");
    expect(stderr).toContain("DEC-0001.md: type is empty");
  });

  it("reports a file that cannot be parsed instead of passing without it", () => {
    const { status, stderr } = checkAfterDamage("unparsable", one, "owner: fixture-owner\n", "");
    expect(status).toBe(1);
    expect(stderr).toContain("DEC-0001.md: missing header line(s): owner");
  });

  it("refuses a value that would split its row, and an unescaped pipe", () => {
    const pipe = checkAfterDamage(
      "pipe",
      one,
      "title: Fixture decision one",
      "title: Fixture | one",
    );
    expect(pipe.stderr).toContain("DEC-0001.md: title contains an unescaped |");
    const lineBreak = checkAfterDamage("break", one, "inside.", "inside.\n\nSecond paragraph.");
    expect(lineBreak.stderr).toContain("DEC-0001.md: rationale contains a line break");
  });

  it("reads DEC-00012 as an id with no file rather than as DEC-0001", () => {
    const { stderr } = checkAfterDamage(
      "long-token",
      "project/decisions/DEC-0002.md",
      "DEC-0001 in part",
      "DEC-00012",
    );
    expect(stderr).toContain("DEC-0002.md: supersedes names DEC-00012");
  });
});

describe("the log renderer and the build refuse what they cannot render faithfully", () => {
  const files = () =>
    readDecisionDirectory(join(CLEAN_FIXTURE, "project/decisions")).entries.map((e) => e.decision);
  const log = () => readFileSync(join(CLEAN_FIXTURE, "project/decision-log.md"), "utf8");

  it("refuses markers out of order, a repeated marker and an intro below the index", () => {
    const swapped = log()
      .replace("<!-- decisions:index:begin -->", "<!-- TMP -->")
      .replace("<!-- decisions:index:end -->", "<!-- decisions:index:begin -->")
      .replace("<!-- TMP -->", "<!-- decisions:index:end -->");
    expect(() => renderDecisionLog(swapped, files())).toThrow(/index-begin, index-end/);
    const repeated = `${log()}\n<!-- decisions:index:begin -->\n`;
    expect(() => renderDecisionLog(repeated, files())).toThrow(/exactly one.*found 2/);
    const intro = "2 decisions, DEC-0001 to DEC-0002 (synthetic fixture).\n";
    const lowered = log()
      .replace(intro, "")
      .replace("## Update Rules", `## Update Rules\n\n${intro}`);
    expect(() => renderDecisionLog(lowered, files())).toThrow(/above the index table/);
  });

  it("refuses a begin marker placed under a table line and an end marker above one", () => {
    const under = log().replace(
      "<!-- decisions:index:begin -->",
      "| ID | Decision | Status | Date |\n<!-- decisions:index:begin -->",
    );
    expect(() => renderDecisionLog(under, files())).toThrow(/begin marker must sit above/);
    const above = log().replace(
      "<!-- decisions:seeded:end -->",
      "<!-- decisions:seeded:end -->\n| stray | row |",
    );
    expect(() => renderDecisionLog(above, files())).toThrow(/end marker must sit below/);
  });

  it("refuses a file of an unknown type instead of dropping it", () => {
    const damaged = files().map((d) =>
      d.id === "DEC-0002" ? { ...d, type: "Decision" as never } : d,
    );
    expect(() => renderDecisionLog(log(), damaged)).toThrow(
      /type "Decision" is not decision or note/,
    );
  });

  it("keeps values verbatim, spaces included, and ends a file with exactly one newline", () => {
    const text = formatDecisionFile(decision({ title: "  padded  ", rationale: "body " }));
    expect(text.endsWith("body \n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(parseDecisionFile("DEC-0007.md", text).title).toBe("  padded  ");
  });

  it("renders tables the register census reads as whole tables", () => {
    expect(orphanedDecisionRows(renderDecisionLog(log(), files()), "fixture")).toEqual([]);
  });

  it("reads the docs directory from --docs and refuses a flag without a value", () => {
    expect(docsDirectory(["--docs", "somewhere"])).toBe("somewhere");
    expect(docsDirectory([])).toBe("docs");
    expect(() => docsDirectory(["--docs"])).toThrow(DecisionRefusal);
  });
});
