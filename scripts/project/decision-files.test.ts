/**
 * Decision files, the log rendered from them, and the two gates over both.
 *
 * Every fixture is synthetic. The gate tests copy the clean fixture to a temp directory and run the
 * real scripts against it, so the exit code asserted is the one `npm run decisions:check` produces.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A copy of the clean fixture the test may damage, in a directory no other test shares. */
const freshDocs = (name: string): string => {
  const docs = mkdtempSync(join(workspace, `${name}-`));
  cpSync(CLEAN_FIXTURE, docs, { recursive: true });
  return docs;
};

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const LOG = "project/decision-log.md";

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

  it.each([".DS_Store", ".DEC-0001.md.swp", "_scratch.md"])(
    "ignores %s, a name starting with a dot or an underscore, in the reader, the check and the build",
    (name) => {
      const docs = freshDocs("ignored-name");
      const dir = join(docs, "project/decisions");
      writeFileSync(join(dir, name), "not a decision\n");
      const { entries, problems } = readDecisionDirectory(dir);
      expect(entries.map((entry) => entry.fileName)).toEqual([
        "DEC-0001.md",
        "DEC-0002.md",
        "NOTE-FIXTURE.md",
      ]);
      expect(problems).toEqual([]);
      const check = run("decisions-check.ts", ["--docs", docs]);
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
      const build = run("decisions-build.ts", ["--check", "--docs", docs]);
      expect(build.stderr).toBe("");
      expect(build.status).toBe(0);
    },
  );
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
    const driftedHash = sha256(logPath);
    expect(run("decisions-build.ts", ["--check", "--docs", docs]).status).toBe(1);
    expect(sha256(logPath), "--check must not write the log").toBe(driftedHash);
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

  it("refuses a docs directory with no decisions directory, and says why", () => {
    const result = run("decisions-check.ts", ["--docs", workspace]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the decisions directory could not be read");
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
    expect(() => docsDirectory(["--docs", "--check"])).toThrow(DecisionRefusal);
  });
});

/** Edits the log of a fresh fixture copy and returns what the check printed. */
const checkAfterLogEdit = (name: string, edit: (log: string) => string) => {
  const docs = freshDocs(name);
  const logPath = join(docs, LOG);
  const before = readFileSync(logPath, "utf8");
  const after = edit(before);
  expect(after, "the edit left the log unchanged").not.toBe(before);
  writeFileSync(logPath, after);
  const result = run("decisions-check.ts", ["--docs", docs]);
  return { docs, logPath, status: result.status, stderr: result.stderr };
};

const MARKERS = [
  "<!-- decisions:index:begin -->",
  "<!-- decisions:index:end -->",
  "<!-- decisions:seeded:begin -->",
  "<!-- decisions:seeded:end -->",
];

describe("decisions:check refuses a log it cannot render, instead of passing", () => {
  it.each(MARKERS)("fails when %s is missing", (marker) => {
    const { status, stderr } = checkAfterLogEdit("missing-marker", (log) =>
      log.replace(`${marker}\n`, ""),
    );
    expect(status).toBe(1);
    expect(stderr).toContain(`FAIL  ${LOG}: expected exactly one ${marker} line, found 0`);
  });

  it.each(MARKERS)("fails when %s is repeated", (marker) => {
    const { status, stderr } = checkAfterLogEdit("repeated-marker", (log) =>
      log.replace(marker, `${marker}\n${marker}`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain(`FAIL  ${LOG}: expected exactly one ${marker} line, found 2`);
  });

  it("fails when the markers are out of order", () => {
    const { status, stderr } = checkAfterLogEdit("order", (log) =>
      log
        .replace(MARKERS[0] as string, "<!-- TMP -->")
        .replace(MARKERS[1] as string, MARKERS[0] as string)
        .replace("<!-- TMP -->", MARKERS[1] as string),
    );
    expect(status).toBe(1);
    expect(stderr).toContain(
      `FAIL  ${LOG}: the four markers are not in index-begin, index-end, seeded-begin, seeded-end order`,
    );
  });

  it("fails when the log has no intro line, or the intro sits below the index", () => {
    const intro = "2 decisions, DEC-0001 to DEC-0002 (synthetic fixture).\n";
    const reason = `FAIL  ${LOG}: no intro line starting with the decisions count above the index table`;
    const gone = checkAfterLogEdit("no-intro", (log) => log.replace(intro, "Two decisions.\n"));
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain(reason);
    const lowered = checkAfterLogEdit("low-intro", (log) =>
      log.replace(intro, "").replace("## Update Rules", `## Update Rules\n\n${intro}`),
    );
    expect(lowered.status).toBe(1);
    expect(lowered.stderr).toContain(reason);
  });

  it("fails when the log cannot be read", () => {
    const docs = freshDocs("log-is-a-directory");
    rmSync(join(docs, LOG));
    mkdirSync(join(docs, LOG));
    const result = run("decisions-check.ts", ["--docs", docs]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FAIL  ${LOG}: could not be read`);
  });

  it("prints one refusal and no stack trace when the log is missing, in the check and the build", () => {
    const docs = freshDocs("log-missing");
    rmSync(join(docs, LOG));
    const check = run("decisions-check.ts", ["--docs", docs]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(`FAIL  ${LOG}: could not be read`);
    expect(check.stderr).not.toContain("    at ");
    const build = run("decisions-build.ts", ["--docs", docs]);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain(`FAIL: ${LOG}: could not be read`);
    expect(build.stderr).not.toContain("    at ");
  });
});

describe("a generated region holds table rows and nothing else", () => {
  it("refuses a line inside the index region, naming its line number", () => {
    const { status, stderr } = checkAfterLogEdit("stray-index", (log) =>
      log.replace(MARKERS[1] as string, `Hand-written text.\n${MARKERS[1]}`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain(`FAIL  ${LOG}: line 12: a generated region holds only table rows`);
  });

  it("refuses a line inside the seeded region, naming its line number", () => {
    const { status, stderr } = checkAfterLogEdit("stray-seeded", (log) =>
      log.replace(MARKERS[3] as string, `Hand-written text.\n${MARKERS[3]}`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain(`FAIL  ${LOG}: line 22: a generated region holds only table rows`);
  });

  it("refuses an end marker moved below prose, and the build deletes nothing", () => {
    const { docs, logPath, status, stderr } = checkAfterLogEdit("moved-end", (log) =>
      log
        .replace(`${MARKERS[3]}\n`, "")
        .replace("Prose here is never generated.", `Prose here is never generated.\n${MARKERS[3]}`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("a generated region holds only table rows");
    const before = sha256(logPath);
    const build = run("decisions-build.ts", ["--docs", docs]);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain("a generated region holds only table rows");
    expect(sha256(logPath), "the build must not rewrite a log it refused").toBe(before);
    expect(readFileSync(logPath, "utf8")).toContain("## Update Rules");
  });
});

describe("marker adjacency is enforced on both tables", () => {
  const beginCases: [string, string][] = [
    ["index", MARKERS[0] as string],
    ["seeded", MARKERS[2] as string],
  ];
  const endCases: [string, string][] = [
    ["index", MARKERS[1] as string],
    ["seeded", MARKERS[3] as string],
  ];

  it.each(beginCases)("refuses the %s begin marker under a table line", (_table, marker) => {
    const { status, stderr } = checkAfterLogEdit("begin-adjacent", (log) =>
      log.replace(marker, `| stray | row |\n${marker}`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("a begin marker must sit above its table, not under a table line");
  });

  it.each(endCases)("refuses the %s end marker above a table line", (_table, marker) => {
    const { status, stderr } = checkAfterLogEdit("end-adjacent", (log) =>
      log.replace(marker, `${marker}\n| stray | row |`),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("an end marker must sit below its table, not above a table line");
  });
});

describe("the build refuses what it cannot read, before it writes", () => {
  it("exits 1, names the file and leaves the log byte-identical when a file does not parse", () => {
    const docs = freshDocs("build-unparsable");
    const file = join(docs, "project/decisions/DEC-0002.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("owner: fixture-owner\n", ""));
    const logPath = join(docs, LOG);
    writeFileSync(logPath, readFileSync(logPath, "utf8").replace("one (short)", "one (edited)"));
    const before = sha256(logPath);
    const build = run("decisions-build.ts", ["--docs", docs]);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain("FAIL: DEC-0002.md: missing header line(s): owner");
    expect(sha256(logPath), "the build must not rewrite the log").toBe(before);
  });

  it("exits 1 and names the file when a type is neither decision nor note", () => {
    const docs = freshDocs("build-unknown-type");
    const file = join(docs, "project/decisions/DEC-0002.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("type: decision", "type: Decision"));
    const logPath = join(docs, LOG);
    const before = sha256(logPath);
    const build = run("decisions-build.ts", ["--docs", docs]);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain('FAIL: DEC-0002.md: type "Decision" is not decision or note');
    expect(sha256(logPath)).toBe(before);
  });
});

describe("only names starting with a dot or an underscore are ignored in the decisions directory", () => {
  it.each(["DEC-0003.MD", "notes.md", "notes.txt", "DEC-12.md", "note-x.md", "DEC-0002.md.bak"])(
    "refuses %s in the check and the build, naming it",
    (name) => {
      const docs = freshDocs("odd-name");
      const dir = join(docs, "project/decisions");
      writeFileSync(join(dir, name), readFileSync(join(dir, "DEC-0002.md"), "utf8"));
      const check = run("decisions-check.ts", ["--docs", docs]);
      expect(check.status).toBe(1);
      expect(check.stderr).toContain(`FAIL  ${name}: is not a decision file name`);
      const logPath = join(docs, LOG);
      const before = sha256(logPath);
      const build = run("decisions-build.ts", ["--docs", docs]);
      expect(build.status).toBe(1);
      expect(build.stderr).toContain(`FAIL: ${name}: is not a decision file name`);
      expect(sha256(logPath)).toBe(before);
    },
  );
});

describe("the check reuses the register census over a fresh render", () => {
  const one = "project/decisions/DEC-0001.md";

  it("fails a date that is not a date, naming the id and the count", () => {
    const { stderr } = checkAfterDamage("soon", one, "date: 2026-01-01", "date: soon");
    expect(stderr).toContain(
      `FAIL  ${LOG}: rows whose Date cell does not hold a date: 2 (DEC-0001, DEC-0001)`,
    );
  });

  it("fails a row whose cell count is not its columns' count", () => {
    const { stderr } = checkAfterDamage("cells", one, "owner: fixture-owner", "owner: a | b");
    expect(stderr).toContain(
      `FAIL  ${LOG}: rows whose cell count is not their columns' count: 1 (DEC-0001)`,
    );
  });

  it("fails a decision row left outside every table", () => {
    const { stderr } = checkAfterLogEdit("orphan", (log) =>
      log.replace(
        "Prose here is never generated.",
        "Prose here is never generated.\n\n| DEC-0009 | stray | accepted | 2026-01-01 |",
      ),
    );
    expect(stderr).toContain(`FAIL  ${LOG}: rows outside every table: 1 (DEC-0009)`);
  });

  it("fails a row written on another row's line", () => {
    const glued =
      "| DEC-0008 | a | accepted | 2026-01-01 | o | r | N/A || DEC-0009 | b | accepted | 2026-01-02 | o | r | N/A |";
    const { stderr } = checkAfterLogEdit("glued", (log) =>
      log.replace("Prose here is never generated.", `Prose here is never generated.\n\n${glued}`),
    );
    expect(stderr).toContain(`FAIL  ${LOG}: rows written on another row's line: 1 (DEC-0009)`);
  });

  it("refuses a carriage return in a header value and in the body", () => {
    const header = checkAfterDamage(
      "cr-header",
      one,
      "title: Fixture decision one\n",
      "title: Fixture decision one\r\n",
    );
    expect(header.stderr).toContain("DEC-0001.md: title contains a line break");
    const body = checkAfterDamage("cr-body", one, "inside.", "inside.\rSecond line.");
    expect(body.stderr).toContain("DEC-0001.md: rationale contains a line break");
  });

  it.each(["id: DEC-0001", "type: decision"])("refuses a carriage return in %s", (line) => {
    const field = line.split(":")[0];
    const { stderr } = checkAfterDamage(`cr-${field}`, one, `${line}\n`, `${line}\r\n`);
    expect(stderr).toContain(`DEC-0001.md: ${field} contains a line break`);
  });

  it("fails a decision that supersedes itself, naming the id and the count", () => {
    const { stderr } = checkAfterDamage(
      "supersedes-itself",
      "project/decisions/DEC-0002.md",
      "DEC-0001 in part",
      "DEC-0002",
    );
    expect(stderr).toContain(`FAIL  ${LOG}: supersede claims naming their own row: 1 (DEC-0002)`);
    expect(stderr).not.toContain("naming an id the log has no row for");
  });

  it("fails a supersede claim on an id the log has no row for, naming the id and the count", () => {
    const { stderr } = checkAfterDamage(
      "supersedes-no-row",
      "project/decisions/DEC-0002.md",
      "DEC-0001 in part",
      "DEC-0900",
    );
    expect(stderr).toContain(
      `FAIL  ${LOG}: supersede claims naming an id the log has no row for: 1 (DEC-0002)`,
    );
    expect(stderr).not.toContain("supersede claims naming their own row");
  });

  it("refuses an empty or whitespace-only index_title, and one equal to the title", () => {
    const empty = checkAfterDamage(
      "empty-index-title",
      one,
      "index_title: Fixture decision one (short)",
      "index_title:",
    );
    expect(empty.stderr).toContain("DEC-0001.md: index_title is empty");
    const blank = checkAfterDamage(
      "blank-index-title",
      one,
      "index_title: Fixture decision one (short)",
      "index_title:    ",
    );
    expect(blank.stderr).toContain("DEC-0001.md: index_title is empty");
    const same = checkAfterDamage(
      "same-index-title",
      one,
      "index_title: Fixture decision one (short)",
      "index_title: Fixture decision one",
    );
    expect(same.stderr).toContain("DEC-0001.md: index_title equals title");
  });
});

describe("every header value is checked for the shape of a row", () => {
  const one = "project/decisions/DEC-0001.md";

  it.each([
    ["index_title", "index_title: Fixture decision one (short)", "index_title: Fixture | one"],
    ["owner", "owner: fixture-owner", "owner: a | b"],
    ["date", "date: 2026-01-01", "date: 2026-01-01 | x"],
    ["supersedes", "supersedes: N/A", "supersedes: N/A | x"],
    ["status", "status: accepted", "status: acc | epted"],
  ])("refuses an unescaped pipe in %s", (field, from, to) => {
    const { status, stderr } = checkAfterDamage(`pipe-${field}`, one, from, to);
    expect(status).toBe(1);
    expect(stderr).toContain(`DEC-0001.md: ${field} contains an unescaped |`);
  });

  it.each(["type", "title", "status", "date", "owner"])("refuses a whitespace-only %s", (field) => {
    const original = new RegExp(`${field}: .*\n`).exec(
      readFileSync(join(CLEAN_FIXTURE, one), "utf8"),
    )?.[0];
    const { stderr } = checkAfterDamage(`blank-${field}`, one, original ?? "", `${field}:    \n`);
    expect(stderr).toContain(`DEC-0001.md: ${field} is empty`);
  });
});

describe("every DEC token in supersedes is checked, with word boundaries", () => {
  const two = "project/decisions/DEC-0002.md";

  it("names a missing decision that follows an existing one", () => {
    const { stderr } = checkAfterDamage(
      "second-token",
      two,
      "DEC-0001 in part",
      "DEC-0001, DEC-0900",
    );
    expect(stderr).toContain("DEC-0002.md: supersedes names DEC-0900, which has no decision file");
    expect(stderr).not.toContain("supersedes names DEC-0001,");
  });

  it("reads DEC-0001x as one token with no file", () => {
    const { stderr } = checkAfterDamage("trailing-letter", two, "DEC-0001 in part", "DEC-0001x");
    expect(stderr).toContain("DEC-0002.md: supersedes names DEC-0001x");
  });

  it("does not read a word that merely contains the letters DEC- as an id", () => {
    const docs = freshDocs("prose-tokens");
    const file = join(docs, two);
    const text = readFileSync(file, "utf8");
    writeFileSync(
      file,
      text.replace("DEC-0001 in part", "DEC-0001 in part, never DEC-logged, not XDEC-9999"),
    );
    expect(run("decisions-build.ts", ["--docs", docs]).status).toBe(0);
    const check = run("decisions-check.ts", ["--docs", docs]);
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });
});
