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
import { fileHoldingOnce, probes } from "../testing/probes/register-gate.mjs";
import {
  ARCHIVE_IN_DOCS,
  REGISTER_IN_DOCS,
  measuredSignature,
  planSweep,
  writePlan,
  type SweepPlan,
} from "./register-sweep";

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

  it("moves an id all of whose entries are finished", () => {
    const live = block(
      OPEN_ENTRY,
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n\n- **A-D2 [HIGH]** Finished, filed twice.",
    );

    const plan = sweep(live);

    expect(plan.entriesMoved).toBe(2);
    expect(plan.live).not.toContain("A-D2");
    expect(plan.archive.match(/\*\*A-D2 /g)).toHaveLength(2);
  });

  it("keeps both entries of an id that has one finished entry and one that is not", () => {
    const finished = "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-01-01.** Finished.";
    const live = block(
      OPEN_ENTRY,
      `### Open\n\n${finished}`,
      "### Amendments to earlier items\n\n- **A-D2** re-anchored by a later close.",
    );

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("keeps an entry with a severity and no anchor and no mark in a block body", () => {
    const live = block("- **A-D3 [MEDIUM]** Not live, and not marked finished.", OPEN_ENTRY);

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("keeps an unmarked entry under a heading that is not a finished one", () => {
    const live = block(OPEN_ENTRY, "### Notes\n\n- **A-D3 [LOW]** Not marked finished.");

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("moves an entry under a finished heading that carries no mark of its own", () => {
    const live = block(OPEN_ENTRY, "### Fixed\n\n- **A-D3 [LOW]** Finished by its heading.");

    const plan = sweep(live);

    expect(plan.entriesMoved).toBe(1);
    expect(plan.live).not.toContain("A-D3");
  });

  it("moves an entry that carries the withdrawal mark under an open heading", () => {
    const live = block(
      OPEN_ENTRY,
      "### Open\n\n- **A-D3 [LOW] → Step 1.2 Block A · WITHDRAWN 2026-01-01, filed in error.** x",
    );

    const plan = sweep(live);

    expect(plan.entriesMoved).toBe(1);
    expect(plan.live).not.toContain("A-D3");
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

  it("keeps a skipped bullet in a block body", () => {
    const live = block("- **Label-1.** A prose bullet in the body.", OPEN_ENTRY);

    const plan = sweep(live);

    expect(plan.bulletsMoved).toBe(0);
    expect(plan.live).toBe(live);
  });

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

  it("removes a sub-heading that holds only a rule line after the move", () => {
    const emptied =
      "## Known Debt (Step 1.0)\n\n### Open\n\n- **A-D1 [HIGH]** Detail of an open id.\n\n" +
      "### Discharged\n\n- **A-D2 [HIGH]** Finished.\n\n---\n";
    const live = `${block(OPEN_ENTRY)}\n${emptied}`;

    const plan = sweep(live);

    expect(plan.headingsRemoved).toBe(1);
    expect(plan.live).not.toContain("### Discharged");
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
    const finished =
      "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-01-01.** Finished, above every block.";
    const live = `# TITLE\n\n${finished}\n\n${block(OPEN_ENTRY)}`;

    const plan = sweep(live);

    expect(plan.live).toBe(live);
    expect(plan.entriesMoved).toBe(0);
  });

  it("starts the batch directly when the archive is empty", () => {
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    const plan = sweep(live, "");

    expect(plan.archive.startsWith("\n<!-- swept 2026-03-05 -->\n\n## ")).toBe(true);
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
      "an unmarked entry, an unmarked skipped bullet and a finished entry in one block body",
      block(
        "- **A-D3 [MEDIUM]** Not live, not marked.",
        "- **Label-1.** A prose bullet.",
        "- **A-D4 [LOW] → Step 1.2 Block A · DISCHARGED 2026-01-01.** Finished.",
        OPEN_ENTRY,
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

describe("an entry that runs over indented paragraphs", () => {
  const FINISHED_HEAD = "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-03-02.** Finished.";
  const BODY = "  The first paragraph of the body.\n\n  The second paragraph of the body.";

  it("moves the indented paragraphs with the entry", () => {
    const live = block(OPEN_ENTRY, `### Discharged\n\n${FINISHED_HEAD}\n\n${BODY}`);

    const plan = sweep(live);

    expect(plan.live).toBe(block(OPEN_ENTRY));
    expect(plan.archive).toContain(`${FINISHED_HEAD}\n\n${BODY}\n`);
  });

  it("moves the indented paragraphs of a skipped bullet", () => {
    const live = block(OPEN_ENTRY, `### Discharged\n\n- **A-D5.** A bullet.\n\n${BODY}`);

    const plan = sweep(live);

    expect(plan.live).toBe(block(OPEN_ENTRY));
    expect(plan.archive).toContain(`- **A-D5.** A bullet.\n\n${BODY}\n`);
  });

  it("leaves the next entry's own paragraphs where they were", () => {
    const live = block(
      OPEN_ENTRY,
      `### Discharged\n\n${FINISHED_HEAD}\n\n${BODY}\n\n- **A-D1 [HIGH]** Kept.\n\n  Its own body.`,
    );

    const plan = sweep(live);

    expect(plan.live).toBe(
      block(OPEN_ENTRY, "### Discharged\n\n- **A-D1 [HIGH]** Kept.\n\n  Its own body."),
    );
  });

  it("refuses a plan that files an entry's head apart from its body", () => {
    const cutting = (liveText: string, archive: string): SweepPlan => ({
      live: liveText.replace(`${FINISHED_HEAD}\n\n`, ""),
      archive: `${archive}\n<!-- swept ${DATE} -->\n\n## Known Debt (Step 1.1)\n\n### Discharged\n\n${FINISHED_HEAD}\n`,
      entriesMoved: 1,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    });
    const live = block(OPEN_ENTRY, `### Discharged\n\n${FINISHED_HEAD}\n\n${BODY}`);

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, cutting)).toThrow(/split an entry/);
  });
});

describe("an entry body the sweep cannot move whole", () => {
  const FINISHED_HEAD = "- **A-D2 [HIGH] → Step 1.2 Block A · DISCHARGED 2026-03-02.** Finished.";

  it("refuses a non-indented line written directly under an indented body line", () => {
    const live = block(
      OPEN_ENTRY,
      `### Discharged\n\n${FINISHED_HEAD}\n\n  First body paragraph.\nA lazy line.\n\n  Second body paragraph.`,
    );

    expect(() => sweep(live)).toThrow(/split an entry/);
  });

  it("moves a body that follows the head after two blank lines", () => {
    const live = block(
      OPEN_ENTRY,
      `### Discharged\n\n${FINISHED_HEAD}\n\n\n  A body after two blank lines.`,
    );

    const plan = sweep(live);

    expect(plan.live).toBe(block(OPEN_ENTRY));
    expect(plan.archive).toContain(`${FINISHED_HEAD}\n\n\n  A body after two blank lines.\n`);
  });

  it("moves a body indented with a tab", () => {
    const live = block(
      OPEN_ENTRY,
      `### Discharged\n\n${FINISHED_HEAD}\n\n\tA body indented with a tab.`,
    );

    const plan = sweep(live);

    expect(plan.live).toBe(block(OPEN_ENTRY));
    expect(plan.archive).toContain(`${FINISHED_HEAD}\n\n\tA body indented with a tab.\n`);
  });
});

/**
 * A planner that does the wrong thing, handed to the output check. Each of these plans is sound in
 * every other respect, so the check that refuses it is the one under test.
 */
describe("a plan that moves work that is not finished", () => {
  const noCounts = { entriesMoved: 1, bulletsMoved: 0, headingsRemoved: 0, blocksRemoved: 0 };
  const batch = (...pieces: string[]): string =>
    `\n<!-- swept ${DATE} -->\n\n## Known Debt (Step 1.1)\n\n${pieces.join("\n\n")}\n`;

  it("refuses to move an entry that is not live and not marked", () => {
    const unmarked = "- **A-D3 [MEDIUM]** Not live, and not marked finished.";
    const live = block(unmarked, OPEN_ENTRY);
    const overreaching = (liveText: string, archive: string): SweepPlan => ({
      live: liveText.replace(`${unmarked}\n\n`, ""),
      archive: `${archive}${batch(unmarked)}`,
      ...noCounts,
    });

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, overreaching)).toThrow(
      /moved work that is not finished/,
    );
  });

  it("refuses to move a finished entry of an id that still has an unfinished one", () => {
    const detail = "- **A-D1 [HIGH]** Finished detail of an id that is open.";
    const live = block(OPEN_ENTRY, `### Discharged\n\n${detail}`);
    const splitting = (liveText: string, archive: string): SweepPlan => ({
      live: liveText.replace(`### Discharged\n\n${detail}\n`, "").trimEnd().concat("\n"),
      archive: `${archive}${batch(`### Discharged\n\n${detail}`)}`,
      ...noCounts,
    });

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, splitting)).toThrow(
      /moved work that is not finished/,
    );
  });

  it("refuses to move a skipped bullet from a heading that is not a finished one", () => {
    const bullet = "- **Label-1.** A prose bullet.";
    const live = block(OPEN_ENTRY, `### Notes\n\n${bullet}`);
    const overreaching = (liveText: string, archive: string): SweepPlan => ({
      live: liveText.replace(`### Notes\n\n${bullet}\n`, "").trimEnd().concat("\n"),
      archive: `${archive}${batch(`### Notes\n\n${bullet}`)}`,
      entriesMoved: 0,
      bulletsMoved: 1,
      headingsRemoved: 1,
      blocksRemoved: 0,
    });

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, overreaching)).toThrow(
      /moved work that is not finished/,
    );
  });
});

/**
 * Each field the output check reads of an entry, changed alone. If a field were dropped from the
 * reading, two registers differing only in that field would read alike.
 */
describe("what the output check reads of an entry", () => {
  const filed = (heading: string, section: string, line: string): string =>
    `## ${heading}\n\n### ${section}\n\n${line}\n`;
  const READING = filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [LOW]** Entry.");

  it("reads the same text the same way twice", () => {
    expect(measuredSignature(READING, "")).toEqual(measuredSignature(READING, ""));
  });

  it.each([
    ["the block heading", filed("Known Debt (Step 1.2)", "Notes", "- **A-D1 [LOW]** Entry.")],
    ["the section heading", filed("Known Debt (Step 1.1)", "Fixed", "- **A-D1 [LOW]** Entry.")],
    ["the severity", filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [HIGH]** Entry.")],
    ["the id", filed("Known Debt (Step 1.1)", "Notes", "- **A-D2 [LOW]** Entry.")],
    [
      "the anchor",
      filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [LOW] → Step 1.2 Block A.** Entry."),
    ],
    [
      "the discharge mark",
      filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [LOW]** Entry · DISCHARGED 2026-01-01."),
    ],
    [
      "the withdrawal mark",
      filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [LOW]** Entry · WITHDRAWN 2026-01-01."),
    ],
  ])("tells a register apart when only %s differs", (_name, other) => {
    expect(measuredSignature(other, "")).not.toEqual(measuredSignature(READING, ""));
  });

  it("tells an anchor apart from another anchor", () => {
    const first = filed("Known Debt (Step 1.1)", "Notes", "- **A-D1 [LOW] → Step 1.2 Block A.** x");
    const second = filed(
      "Known Debt (Step 1.1)",
      "Notes",
      "- **A-D1 [LOW] → Step 1.3 Block A.** x",
    );

    expect(measuredSignature(first, "")).not.toEqual(measuredSignature(second, ""));
  });

  it("reads the archive text as well as the live text", () => {
    expect(measuredSignature(READING, READING)).not.toEqual(measuredSignature(READING, ""));
  });

  describe("and of a skipped bullet", () => {
    const BULLET = filed("Known Debt (Step 1.1)", "Discharged", "- **Label-1.** Bullet.");

    it("tells a bullet apart from none", () => {
      expect(measuredSignature(BULLET, "")).not.toEqual(
        measuredSignature(filed("Known Debt (Step 1.1)", "Discharged", "Prose."), ""),
      );
    });

    it("tells a bullet apart from another bullet", () => {
      const other = filed("Known Debt (Step 1.1)", "Discharged", "- **Label-2.** Bullet.");

      expect(measuredSignature(other, "")).not.toEqual(measuredSignature(BULLET, ""));
    });

    it("tells a bullet apart by the heading it sits under", () => {
      const other = filed("Known Debt (Step 1.1)", "Fixed", "- **Label-1.** Bullet.");

      expect(measuredSignature(other, "")).not.toEqual(measuredSignature(BULLET, ""));
    });
  });
});

describe("what the output check refuses in a plan that is otherwise sound", () => {
  const sameCounts = { entriesMoved: 0, bulletsMoved: 0, headingsRemoved: 0, blocksRemoved: 0 };

  it("refuses a plan that invents a line", () => {
    const inventing = (liveText: string, archive: string): SweepPlan => ({
      live: `${liveText}\nAn invented line.\n`,
      archive,
      ...sameCounts,
    });

    expect(() => planSweep(block(OPEN_ENTRY), EMPTY_ARCHIVE, DATE, inventing)).toThrow(
      /lost or invented a line/,
    );
  });

  it("refuses a plan that moves an entry to a different block heading", () => {
    const rehomed = (liveText: string, archive: string): SweepPlan => ({
      live: liveText.replace("### Discharged\n\n- **A-D2 [HIGH]** Finished.\n", ""),
      archive: `${archive}\n## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D2 [HIGH]** Finished.\n`,
      entriesMoved: 1,
      bulletsMoved: 0,
      headingsRemoved: 0,
      blocksRemoved: 0,
    });
    const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

    expect(() => planSweep(live, EMPTY_ARCHIVE, DATE, rehomed)).toThrow(/does not measure like/);
  });
});

describe("writing a plan", () => {
  const live = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");

  const pathsFor = () => {
    const [livePath, archivePath] = filesFor(live, EMPTY_ARCHIVE);
    return { live: livePath, archive: archivePath };
  };

  it("writes the archive first and the live file second", () => {
    const paths = pathsFor();
    const written: string[] = [];

    writePlan(sweep(live), paths, (path) => {
      written.push(path);
    });

    expect(written).toEqual([paths.archive, paths.live]);
  });

  it("leaves the live file as it was and the batch in the archive when the second write fails", () => {
    const paths = pathsFor();
    const plan = sweep(live);
    let writes = 0;
    const failingSecond = (path: string, text: string): void => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      writeFileSync(path, text);
    };

    expect(() => writePlan(plan, paths, failingSecond)).toThrow("disk full");

    expect(readFileSync(paths.live, "utf8")).toBe(live);
    expect(readFileSync(paths.archive, "utf8")).toBe(plan.archive);
    expect(readFileSync(paths.archive, "utf8")).toContain("- **A-D2 [HIGH]** Finished.");
  });
});

describe("the register probe's wiring", () => {
  it("names the live file and the archive file for the discharge probe", () => {
    const probe = probes.find((candidate: { name: string }) =>
      candidate.name.startsWith("a discharge declared in prose"),
    );

    expect(probe?.files).toEqual([
      "docs/project/open-debt.md",
      "docs/archive/project/open-debt-archive.md",
    ]);
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
        measurement.obligation.what ===
        "entries filed in the archive file that carry no mark of being finished",
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

  it("exits 1 under --check when only skipped bullets would move", () => {
    const onlyABullet = block(OPEN_ENTRY, "### Discharged\n\n- **Label-1.** A finished bullet.");
    const docs = docsWith(onlyABullet, EMPTY_ARCHIVE);

    const result = run(docs, "--check");

    expect(result.status).toBe(1);
    expect(result.err).toContain("a sweep is pending: 0 entries and 1 skipped bullets moved");
    expect(bytes(docs)).toEqual([onlyABullet, EMPTY_ARCHIVE]);
  }, 30_000);

  it("exits 1 under --check when only entries would move", () => {
    const onlyAnEntry = block(OPEN_ENTRY, "### Discharged\n\n- **A-D2 [HIGH]** Finished.");
    const docs = docsWith(onlyAnEntry, EMPTY_ARCHIVE);

    const result = run(docs, "--check");

    expect(result.status).toBe(1);
    expect(result.err).toContain("a sweep is pending: 1 entries and 0 skipped bullets moved");
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
