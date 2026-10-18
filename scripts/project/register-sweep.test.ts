/**
 * The register sweep: what it moves, what it leaves, and that the gate cannot tell the difference.
 *
 * Every register in this file is synthetic. The shapes are the ones the real register is measured to
 * hold, but no text is taken from it: the product repository is public and the register is not.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RegisterRefusal,
  censusDebtItems,
  censusDebtItemsFromText,
  measureRegister,
  summariseRegister,
} from "./register-census";
// @ts-expect-error the probe suite is plain JavaScript with no declaration file
import { fileHoldingOnce } from "../testing/probes/register-gate.mjs";
import { ARCHIVE_IN_DOCS, REGISTER_IN_DOCS, planSweep, type SweepPlan } from "./register-sweep";

const FIXTURES = join(__dirname, "..", "testing", "fixtures", "register-sweep");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const DECISION_LOG = "docs/project/decision-log.md";
const DATE = "2026-03-05";

const workspace = mkdtempSync(join(tmpdir(), "register-sweep-"));
let scratchCount = 0;

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const EMPTY_ARCHIVE = "# ARCHIVE\n";

const sweep = (live: string, archive: string = EMPTY_ARCHIVE): SweepPlan =>
  planSweep(live, archive, DATE);

/** A register of one block, the shape the real register files its work in. */
const block = (...parts: string[]): string => `## Known Debt (Step 1.1)\n\n${parts.join("\n\n")}\n`;

const OPEN_ENTRY = "### Open\n\n- **A-D1 [HIGH] → Step 1.2 Block A.** Live.";

/** Writes a live and an archive text into a scratch directory and returns both paths. */
const filesFor = (live: string, archive: string): [string, string] => {
  scratchCount += 1;
  const directory = join(workspace, `case-${scratchCount}`);
  mkdirSync(directory);
  const livePath = join(directory, "live.md");
  const archivePath = join(directory, "archive.md");
  writeFileSync(livePath, live);
  writeFileSync(archivePath, archive);
  return [livePath, archivePath];
};

/** Everything the gate reads of a register held in two texts, with line numbers left out. */
const measuredAs = (live: string, archive: string) => {
  const [livePath, archivePath] = filesFor(live, archive);
  const items = censusDebtItems([livePath, archivePath]);
  const obligations = measureRegister([livePath, archivePath], archivePath, DECISION_LOG).map(
    (measurement) => [measurement.obligation.what, measurement.measured],
  );
  const entries = items
    .map((item) => [item.id, item.live, item.discharged, item.withdrawn, item.anchor].join("|"))
    .sort();
  return { summary: summariseRegister(items), obligations, entries };
};

const proseLines = (...texts: string[]): string[] =>
  texts
    .flatMap((text) => text.split("\n"))
    .filter((raw) => raw.trim() !== "" && !/^#{1,6} /.test(raw))
    .sort();

describe("what an id's entries do together", () => {
  it("keeps every entry of an id that has a live entry, wherever each sits", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **A-D1 [HIGH]** The finished detail entry.",
    );

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("moves an id none of whose entries is live", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n\n- **A-D2 [HIGH]** Finished, filed twice.",
    );

    const plan = sweep(live);

    expect(plan.entriesMoved).toBe(2);
    expect(plan.live).not.toContain("A-D2");
    expect(plan.archive.match(/\*\*A-D2 /g)).toHaveLength(2);
  });

  it("moves a block-body entry, with no sub-heading made up for it", () => {
    const live = block(
      "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-01-01.** Finished.",
      OPEN_ENTRY,
    );

    const plan = sweep(live);
    const moved = censusDebtItemsFromText(plan.archive, "archive").find(
      (item) => item.id === "A-D2",
    );

    expect(moved?.section).toBe("");
    expect(plan.archive).toMatch(/## Known Debt \(Step 1\.1\)\n\n- \*\*A-D2/);
  });

  it("keeps the exact text of the heading an entry sat under", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged in this phase, with a comma\n\n- **A-D2 [HIGH]** Finished.",
    );

    const plan = sweep(live);
    const moved = censusDebtItemsFromText(plan.archive, "archive").find(
      (item) => item.id === "A-D2",
    );

    expect(moved?.section).toBe("### Discharged in this phase, with a comma");
  });

  it("moves a bullet that runs over several lines as one piece", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **Label-1.** First line.\n  Second line.\n  Third line.",
    );

    const plan = sweep(live);

    expect(plan.archive).toContain("- **Label-1.** First line.\n  Second line.\n  Third line.");
    expect(plan.live).not.toContain("Second line.");
  });

  it("moves an entry that runs over several lines as one piece", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **A-D2 [HIGH]** First line.\n  Second line.\n  Third line.",
    );

    const plan = sweep(live);

    expect(plan.archive).toContain("- **A-D2 [HIGH]** First line.\n  Second line.\n  Third line.");
    expect(plan.live).not.toContain("Third line.");
  });
});

describe("which bullets that are not entries move", () => {
  it.each([
    "Discharged",
    "Discharged in this phase",
    "Fixed in-step after depth review",
    "Withdrawn — do not carry",
  ])("moves a skipped bullet under ### %s", (heading) => {
    const live = block(OPEN_ENTRY, `### ${heading}\n\n- **Label-1.** A finished bullet.`);

    const plan = sweep(live);

    expect(plan.bulletsMoved).toBe(1);
    expect(plan.live).not.toContain("Label-1");
    expect(plan.archive).toContain(`### ${heading}\n\n- **Label-1.** A finished bullet.`);
  });

  it.each(["Open", "Notes", "Amendments to earlier items", "Still open"])(
    "keeps a skipped bullet under ### %s",
    (heading) => {
      const live = block(OPEN_ENTRY, `### ${heading}\n\n- **Label-1.** A prose bullet.`);

      const plan = sweep(live);

      expect(plan.bulletsMoved).toBe(0);
      expect(plan.live).toBe(live);
    },
  );

  it("keeps a Learnings bullet", () => {
    const live = block(OPEN_ENTRY, "### Learnings\n\n- **A lesson** that carries no id.");

    expect(sweep(live).live).toBe(live);
  });

  it("keeps a prose bullet that has no bold head at all", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- CLOSED and swept: a pointer line.");

    expect(sweep(live).live).toBe(live);
  });
});

describe("what a move leaves behind", () => {
  it("removes a sub-heading the move leaves empty", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    const plan = sweep(live);

    expect(plan.headingsRemoved).toBe(1);
    expect(plan.live).toBe(block(OPEN_ENTRY));
  });

  it("keeps a sub-heading that still holds an entry", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n\n- **A-D1 [HIGH]** Kept, its id is open.",
    );

    const plan = sweep(live);

    expect(plan.headingsRemoved).toBe(0);
    expect(plan.live).toContain("### Discharged\n\n- **A-D1 [HIGH]** Kept");
  });

  it("keeps a sub-heading that still holds prose", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\nA sentence of prose.\n\n- **A-D2 [HIGH]** Finished.",
    );

    const plan = sweep(live);

    expect(plan.headingsRemoved).toBe(0);
    expect(plan.live).toContain("### Discharged\n\nA sentence of prose.");
  });

  it("moves a block left with no entry whole, prose and all", () => {
    const emptied =
      "## Known Debt (Step 1.0)\n\nProse that belongs to the block.\n\n" +
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n\n---\n";
    const live = `${block(OPEN_ENTRY)}\n${emptied}`;

    const plan = sweep(live);

    expect(plan.blocksRemoved).toBe(1);
    expect(plan.headingsRemoved).toBe(0);
    expect(plan.live).not.toContain("Step 1.0");
    expect(plan.live).not.toContain("Prose that belongs");
    expect(plan.archive).toContain("## Known Debt (Step 1.0)\n\nProse that belongs to the block.");
    expect(plan.archive).toContain("### Discharged\n\n- **A-D2 [HIGH]** Finished.");
  });

  it("keeps a block that still holds an entry whose id is open", () => {
    const kept =
      "## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D1 [HIGH]** Finished detail of an open id.\n" +
      "\n- **A-D2 [HIGH]** Finished.\n";
    const live = `${block(OPEN_ENTRY)}\n${kept}`;

    const plan = sweep(live);

    expect(plan.blocksRemoved).toBe(0);
    expect(plan.live).toContain("## Known Debt (Step 1.0)");
    expect(plan.live).toContain("Finished detail of an open id.");
  });

  it("keeps a block that still holds a skipped bullet", () => {
    const kept =
      "## Known Debt (Step 1.0)\n\n### Notes\n\n- **Label-1.** A prose bullet.\n\n" +
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n";
    const live = `${block(OPEN_ENTRY)}\n${kept}`;

    const plan = sweep(live);

    expect(plan.blocksRemoved).toBe(0);
    expect(plan.live).toContain("- **Label-1.** A prose bullet.");
  });

  it("does not collapse blank lines the move did not touch", () => {
    const live = block(
      OPEN_ENTRY,
      "Prose.\n\n\n\nMore prose.",
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.",
    );

    expect(sweep(live).live).toContain("Prose.\n\n\n\nMore prose.");
  });

  it("appends one dated batch to the end of the archive, after what is already there", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    const plan = sweep(live, "# ARCHIVE\n\nOld text.\n");

    expect(plan.archive.startsWith("# ARCHIVE\n\nOld text.\n\n<!-- swept 2026-03-05 -->\n\n")).toBe(
      true,
    );
    expect(plan.archive.endsWith("- **A-D2 [HIGH]** Finished.\n")).toBe(true);
  });

  it("keeps an entry that sits above the first block heading", () => {
    const live = `# TITLE\n\n- **A-D2 [HIGH]** Finished, above every block.\n\n${block(OPEN_ENTRY)}`;

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("starts the batch on a new line when the archive does not end with one", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    const plan = sweep(live, "# ARCHIVE\n\nOld text.");

    expect(plan.archive.startsWith("# ARCHIVE\n\nOld text.\n\n<!-- swept 2026-03-05 -->\n")).toBe(
      true,
    );
  });

  it("ends the live file with a newline when its last block is the one that goes", () => {
    const last = "## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D2 [HIGH]** Finished.\n";
    const live = `${block(OPEN_ENTRY).trimEnd()}\n${last}`;

    const plan = sweep(live);

    expect(plan.blocksRemoved).toBe(1);
    expect(plan.live.endsWith("Live.\n")).toBe(true);
  });

  it("does not change an archive, or a live file, when nothing is movable", () => {
    const live = block(OPEN_ENTRY);

    const plan = sweep(live, "# ARCHIVE\n");

    expect([plan.live, plan.archive]).toEqual([live, "# ARCHIVE\n"]);
    expect(plan.archive).not.toContain("swept");
  });
});

describe("the synthetic register", () => {
  const sweptFixture = () => planSweep(fixture("live.md"), fixture("archive.md"), DATE);

  it("sweeps to the expected live file", () => {
    const plan = sweptFixture();

    expect(plan.live).toBe(fixture("live.swept.md"));
  });

  it("sweeps to the expected archive file", () => {
    const plan = sweptFixture();

    expect(plan.archive).toBe(fixture("archive.swept.md"));
  });

  it("reports what it moved", () => {
    const plan = sweptFixture();

    expect({
      entriesMoved: plan.entriesMoved,
      bulletsMoved: plan.bulletsMoved,
      headingsRemoved: plan.headingsRemoved,
      blocksRemoved: plan.blocksRemoved,
    }).toEqual({ entriesMoved: 5, bulletsMoved: 3, headingsRemoved: 1, blocksRemoved: 1 });
  });

  it("keeps the archive's earlier text word for word", () => {
    const plan = sweptFixture();

    expect(plan.archive.startsWith(fixture("archive.md"))).toBe(true);
  });

  it("is a no-op the second time", () => {
    const plan = sweptFixture();
    const again = planSweep(plan.live, plan.archive, "2026-04-01");

    expect([again.live, again.archive]).toEqual([plan.live, plan.archive]);
    expect(again.entriesMoved + again.bulletsMoved).toBe(0);
  });
});

describe("what the sweep must not change", () => {
  const scenarios: Array<[string, string, string]> = [
    ["the synthetic register", fixture("live.md"), fixture("archive.md")],
    [
      "an open id filed again as finished, beside a finished id",
      block(
        OPEN_ENTRY,
        "### Discharged\n\n- **A-D1 [HIGH]** Finished detail.\n\n- **A-D2 [HIGH]** Finished.",
      ),
      EMPTY_ARCHIVE,
    ],
    [
      "a finished block-body entry and a finished sub-section",
      block(
        "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-01-01.** Finished.",
        OPEN_ENTRY,
        "### Discharged\n\n- **A-D3 [HIGH]** Finished.\n\n- **Label-1.** A bullet.",
      ),
      EMPTY_ARCHIVE,
    ],
    [
      "a block with nothing live in it",
      `${block(OPEN_ENTRY)}\n## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D4 [HIGH]** Finished.\n`,
      EMPTY_ARCHIVE,
    ],
  ];

  it.each(scenarios)(
    "measures %s the same across the two texts as in the one",
    (_name, live, archive) => {
      const plan = planSweep(live, archive, DATE);

      expect(measuredAs(plan.live, plan.archive)).toEqual(measuredAs(live, archive));
    },
  );

  it.each(scenarios)("loses and invents no line of %s", (_name, live, archive) => {
    const plan = planSweep(live, archive, DATE);

    expect(proseLines(plan.live, plan.archive)).toEqual(
      proseLines(live, archive, "<!-- swept 2026-03-05 -->"),
    );
  });
});

describe("what the sweep refuses", () => {
  it("refuses a live register the census cannot classify", () => {
    expect(() => sweep("## Known Debt (Step 1.1)\n\n- **A-D1 [HIGH] Never closed.\n")).toThrow(
      RegisterRefusal,
    );
  });

  it("refuses an archive the census cannot classify", () => {
    expect(() =>
      sweep(block(OPEN_ENTRY), "## Known Debt\n\n- **A-D1 [HIGH Never closed.\n"),
    ).toThrow(RegisterRefusal);
  });

  it.each(["2026-3-5", "05-03-2026", "today", ""])("refuses the date %j", (date) => {
    expect(() => planSweep(block(OPEN_ENTRY), EMPTY_ARCHIVE, date)).toThrow(RegisterRefusal);
  });

  it("refuses a plan that rewrites an entry the census reads", () => {
    const lossy = (live: string, archive: string): SweepPlan => ({
      live: live.replace("Live.", "Live, edited."),
      archive,
      entriesMoved: 0,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    });
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, lossy)).toThrow(/does not measure like/);
  });

  it("refuses a plan that moves an entry under a different heading", () => {
    const rehomed = (live: string, archive: string): SweepPlan => ({
      live: live.replace("### Discharged\n\n- **A-D2 [HIGH]** Finished.\n", ""),
      archive: `${archive}\n## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D2 [HIGH]** Finished.\n`,
      entriesMoved: 1,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    });
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, rehomed)).toThrow(/does not measure like/);
  });

  it("refuses a plan that drops a prose line while keeping every entry", () => {
    const dropping = (live: string, archive: string): SweepPlan => ({
      live: live.replace("Some prose.\n\n", ""),
      archive,
      entriesMoved: 0,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    });
    const live = block("Some prose.", OPEN_ENTRY);

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, dropping)).toThrow(/lost or invented a line/);
  });
});

describe("a live entry planted in the archive", () => {
  const planted = "## Known Debt (Step 1.0)\n\n### Open\n\n- **A-D9 [HIGH]** Still owed.\n";

  it("is not moved, and the archive obligation reads one", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    const plan = sweep(live, `# ARCHIVE\n\n${planted}`);
    const [livePath, archivePath] = filesFor(plan.live, plan.archive);
    const archiveOwing = measureRegister([livePath, archivePath], archivePath, DECISION_LOG).find(
      (measurement) =>
        measurement.obligation.what === "live debt entries filed in the archive file",
    );

    expect(plan.archive).toContain(planted);
    expect(archiveOwing?.measured).toBe(1);
  });
});

/**
 * The command line, run as a process against a scratch docs directory.
 *
 * `--check` and `--write` decide whether the files are touched at all, so they are exercised through
 * the entry point rather than by calling a function the entry point might not reach.
 */
describe("the register:sweep command", () => {
  const script = join(__dirname, "register-sweep.ts");

  const docsWith = (live: string, archive: string): string => {
    scratchCount += 1;
    const docs = join(workspace, `docs-${scratchCount}`);
    mkdirSync(dirname(join(docs, REGISTER_IN_DOCS)), { recursive: true });
    mkdirSync(dirname(join(docs, ARCHIVE_IN_DOCS)), { recursive: true });
    writeFileSync(join(docs, REGISTER_IN_DOCS), live);
    writeFileSync(join(docs, ARCHIVE_IN_DOCS), archive);
    return docs;
  };

  const run = (docs: string, ...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, "--docs", docs, ...args],
      { encoding: "utf8" },
    );
    return { status: result.status, out: result.stdout, err: result.stderr };
  };

  const bytes = (docs: string) => [
    readFileSync(join(docs, REGISTER_IN_DOCS), "utf8"),
    readFileSync(join(docs, ARCHIVE_IN_DOCS), "utf8"),
  ];

  it("exits 1 under --check when a sweep is pending, and writes nothing", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));

    const result = run(docs, "--check");

    expect(result.status).toBe(1);
    expect(result.err).toContain("a sweep is pending: 5 entries and 3 skipped bullets moved");
    expect(bytes(docs)).toEqual([fixture("live.md"), fixture("archive.md")]);
  }, 30_000);

  it("checks when given no mode at all", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));

    const result = run(docs);

    expect(result.status).toBe(1);
    expect(bytes(docs)).toEqual([fixture("live.md"), fixture("archive.md")]);
  }, 30_000);

  it("exits 0 under --check when nothing is movable", () => {
    const docs = docsWith(fixture("live.swept.md"), fixture("archive.swept.md"));

    const result = run(docs, "--check");

    expect(result.status).toBe(0);
    expect(result.out).toContain("nothing to sweep");
  }, 30_000);

  it("writes both files under --write, and a second --write changes nothing", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));

    const first = run(docs, "--write", "--date", DATE);
    const afterFirst = bytes(docs);
    const second = run(docs, "--write", "--date", "2026-04-01");

    expect(first.status).toBe(0);
    expect(afterFirst).toEqual([fixture("live.swept.md"), fixture("archive.swept.md")]);
    expect(second.status).toBe(0);
    expect(bytes(docs)).toEqual(afterFirst);
  }, 30_000);

  it("exits 0 under --check after a --write", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));
    run(docs, "--write", "--date", DATE);

    expect(run(docs, "--check").status).toBe(0);
  }, 30_000);

  it("dates the batch with today when --date is not given", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));

    run(docs, "--write");

    expect(bytes(docs)[1]).toMatch(/\n<!-- swept \d{4}-\d{2}-\d{2} -->\n/);
  }, 30_000);

  it("refuses an unreadable archive by name and writes nothing", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));
    rmSync(join(docs, ARCHIVE_IN_DOCS));

    const result = run(docs, "--write", "--date", DATE);

    expect(result.status).toBe(1);
    expect(result.err).toContain("open-debt-archive.md");
    expect(readFileSync(join(docs, REGISTER_IN_DOCS), "utf8")).toBe(fixture("live.md"));
  }, 30_000);

  it("refuses an unreadable live register by name and writes nothing", () => {
    const docs = docsWith(fixture("live.md"), fixture("archive.md"));
    rmSync(join(docs, REGISTER_IN_DOCS));

    const result = run(docs, "--write", "--date", DATE);

    expect(result.status).toBe(1);
    expect(result.err).toContain("open-debt.md");
    expect(readFileSync(join(docs, ARCHIVE_IN_DOCS), "utf8")).toBe(fixture("archive.md"));
  }, 30_000);

  it.each([
    [["--write", "--check"], "cannot be combined with --check"],
    [["--wirte"], "is not an argument register:sweep takes"],
    [["--write", "--wirte"], "is not an argument register:sweep takes"],
    [["--write", "--date", "yesterday"], "is not YYYY-MM-DD"],
    [["--write", "--date"], "needs a date"],
  ])(
    "refuses the arguments %j and writes nothing",
    (args, reason) => {
      const docs = docsWith(fixture("live.md"), fixture("archive.md"));

      const result = run(docs, ...args);

      expect(result.status).toBe(1);
      expect(result.err).toContain(reason);
      expect(bytes(docs)).toEqual([fixture("live.md"), fixture("archive.md")]);
    },
    30_000,
  );
});

describe("the register probe's anchor locator", () => {
  const locate = (live: string, archive: string, anchor: string): string => {
    const [livePath, archivePath] = filesFor(live, archive);
    return fileHoldingOnce(anchor, [livePath, archivePath]) as string;
  };

  it("names the live file when the anchor sits only there", () => {
    expect(locate("one ANCHOR here", "nothing", "ANCHOR")).toMatch(/live\.md$/);
  });

  it("names the archive file when the anchor sits only there", () => {
    expect(locate("nothing", "one ANCHOR here", "ANCHOR")).toMatch(/archive\.md$/);
  });

  it("refuses an anchor that sits in neither file", () => {
    expect(() => locate("nothing", "nothing", "ANCHOR")).toThrow(/found 0/);
  });

  it("refuses an anchor that sits in both files", () => {
    expect(() => locate("ANCHOR", "ANCHOR", "ANCHOR")).toThrow(/found 2/);
  });

  it("refuses an anchor that sits twice in one file", () => {
    expect(() => locate("ANCHOR and ANCHOR", "nothing", "ANCHOR")).toThrow(/found 2/);
  });
});
