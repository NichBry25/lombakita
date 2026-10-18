/**
 * The gate over the two registers a close writes: `open-debt.md` and `decision-log.md`.
 *
 * The census itself is exercised against FIXTURE REGISTER TEXT built in this file, so what each
 * classifier does is pinned independently of what the registers currently happen to contain.
 * Otherwise the only assertion would be a number, and a number agrees with whatever produced it.
 *
 * Every fixture below is a form the real registers were measured to contain, or a form a previous
 * reading of them got wrong. The ratchets are then asserted against the real files, exactly.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REGISTER_OBLIGATIONS,
  RegisterRefusal,
  type RegisterMeasurement,
  anchorlessLiveIds,
  bareAnchoredLiveIds,
  canonicalAnchoredLiveIds,
  censusDebtItems,
  censusDebtItemsFromText,
  censusSkippedBullets,
  committedRegister,
  decisionRecords,
  measureRegister,
  dischargedWithoutMark,
  gluedRecords,
  liveIds,
  newlyFiledWithoutStepAnchor,
  orphanedDecisionRows,
  rowsOffColumnCount,
  rowsWithNonDate,
  summariseRegister,
  supersedeClaimOf,
  supersedesFindings,
} from "./register-census";

const workspace = mkdtempSync(join(tmpdir(), "register-census-"));

/** A throwaway git repository, so gate (a)'s baseline is exercised against a real one (Rule 33). */
const repo = join(workspace, "repo");
mkdirSync(repo, { recursive: true });

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const OPEN_DEBT = "docs/project/open-debt.md";
const OPEN_DEBT_ARCHIVE = "docs/archive/project/open-debt-archive.md";
const DECISION_LOG = "docs/project/decision-log.md";

/** Reads one throwaway register and returns its items. */
const itemsOf = (name: string, source: string) => {
  const file = join(workspace, name);
  writeFileSync(file, source);

  return censusDebtItems([file]);
};

const recordsOf = (name: string, source: string) => {
  const file = join(workspace, name);
  writeFileSync(file, source);

  return decisionRecords(source, file);
};

const refusalFrom = (name: string, source: string): string => {
  try {
    itemsOf(name, source);
  } catch (error) {
    expect(error).toBeInstanceOf(RegisterRefusal);
    return (error as Error).message;
  }

  throw new Error(`the census classified ${name} instead of refusing it`);
};

describe("where an item's disposition is read from", () => {
  it("counts an item under a disposition sub-section as live", () => {
    const items = itemsOf(
      "open.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** Something is owed.\n",
    );

    expect(summariseRegister(items).live).toBe(1);
  });

  // The register files most of its items in a block body with no sub-heading at all — measured at
  // 285 of 423. Those are not live by the file's own structure, and reading them as live is what
  // made one derivation of "live" disagree with another by more than four times.
  it("does not count an item in a block body as live", () => {
    const items = itemsOf("body.md", "## Known Debt (Step 1.1)\n\n- **A-D1 [HIGH]** Something.\n");

    expect(summariseRegister(items).live).toBe(0);
  });

  it("does not count an item under a Discharged heading as live", () => {
    const items = itemsOf(
      "discharged.md",
      "## Known Debt (Step 1.1)\n\n### Discharged by this block\n\n- **A-D1 [HIGH]** Done.\n",
    );

    expect(summariseRegister(items).live).toBe(0);
  });

  it("closes a live item that carries the discharge mark", () => {
    const items = itemsOf(
      "marked.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n" +
        "- **A-D1 [HIGH]** → Step 1.2 · DISCHARGED 2026-09-09. Fixed.\n",
    );

    expect(summariseRegister(items).live).toBe(0);
  });

  /**
   * The regression this classifier exists for. A closure vocabulary read over head lines closed
   * seven items on their EVIDENCE PROSE — "Mitigated but not closed", "the incident closed
   * 2026-08-07", "failing closed" — and all three it closed under a live section were false closes.
   * The register states a disposition with one mark, and nothing else in the line is read.
   */
  it("does not close an item on a closure word in its evidence", () => {
    const items = itemsOf(
      "prose.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n" +
        "- **A-D1 [HIGH]** The incident closed 2026-08-07 and the class itself is not closed; " +
        "failing closed is the intended behaviour.\n",
    );

    expect(summariseRegister(items).live).toBe(1);
  });

  // The register writes an item across two lines and the bold run wraps onto the second. Reading
  // only the first line refuses this file outright.
  it("reads an item whose bold run wraps onto the next line", () => {
    const items = itemsOf(
      "wrapped.md",
      "## Known Debt (Step 1.1)\n\n" +
        '- **A-D1 [HIGH] → Step 7.7 Block C2 (re-anchored from "Block C Phase 3").\n' +
        "  THE MATRIX SEED IS 0 ROUTED WRITES AGAINST 38 RAW.**\n",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.anchor).toMatch(/^→ Step 7\.7 Block C2/);
  });

  it("does not read an anchor out of the evidence prose", () => {
    const items = itemsOf(
      "prose-anchor.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n" +
        "- **A-D1 [HIGH]** Fix it.\n" +
        "  The path runs → Block D afterwards, as the note says.\n\n" +
        "- **A-D2 [LOW]** → Block D. Anchored.\n",
    );

    const [, anchored] = items;

    expect(items[0]?.anchor).toBeNull();
    expect(anchored?.anchor).toMatch(/^→ Block D\b/);
  });

  // Measured: seven items on the register put the arrow in the HEAD line's own prose rather than in
  // a continuation line — `(picker →`, `` `auth.suspendedAt.load_failed` → ``, `full→personal`,
  // `no old-slug→new redirect table`. None of them is a destination, and a reader that took the
  // first arrow on the line credited all seven with an anchor they were never given.
  it("does not read an anchor out of the head line's own prose", () => {
    const items = itemsOf(
      "headline-prose.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n" +
        "- **A-D1 [NEW-TEST]:** no component test for the rewritten shell (picker →\n" +
        "  the dialog opens).\n",
    );

    expect(items[0]?.anchor).toBeNull();
  });

  // A severity value can carry an arrow of its own, as `[PARTIAL → minimum surfacing landed]` does.
  it("does not read an anchor out of the severity bracket", () => {
    const items = itemsOf(
      "bracketed.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [PARTIAL → landed]** Still owed.\n",
    );

    expect(items[0]?.anchor).toBeNull();
  });
});

describe("the three anchor forms", () => {
  const forms = itemsOf(
    "forms.md",
    "## Known Debt (Step 1.1)\n\n### Open\n\n" +
      "- **A-D1 [HIGH]** → Step 7.7 Block D. Canonical.\n\n" +
      "- **A-D2 [HIGH]** → Block D. Bare.\n\n" +
      "- **A-D3 [HIGH]** → Step 7.7. Names a step, no block.\n\n" +
      "- **A-D4 [HIGH]** No anchor.\n",
  );

  it("separates a canonical anchor from a bare one", () => {
    expect(bareAnchoredLiveIds(forms)).toEqual(["A-D2"]);
  });

  it("separates an anchorless item from an anchored one", () => {
    expect(anchorlessLiveIds(forms)).toEqual(["A-D4"]);
  });

  // `→ Step 7.7.` names a step and no block. Twenty live items carry that form, and a rule that
  // called it bare would demand a bulk rewrite of all twenty.
  it("does not call a step anchor without a block bare", () => {
    expect(bareAnchoredLiveIds(forms)).not.toContain("A-D3");
  });

  it("counts ids, not entries, so a twice-filed item moves the number once", () => {
    const items = itemsOf(
      "twice.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n" +
        "- **A-D1 [HIGH]** Filed here.\n\n" +
        "## Known Debt (Step 1.2)\n\n### Open\n\n" +
        "- **A-D1 [HIGH]** Filed again, still with no anchor.\n",
    );

    const summary = summariseRegister(items);

    expect(summary.anchorlessLive).toBe(1);
    expect(summary.anchorlessLiveEntries).toBe(2);
    expect(liveIds(items)).toEqual(["A-D1"]);
  });
});

describe("the Phase 8 anchor form", () => {
  /** One live item anchored with `anchor`, written the way the register writes a headline entry. */
  const itemAnchoredWith = (anchor: string) =>
    itemsOf(
      "phase-eight.md",
      `## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [LOW]** ${anchor}\n`,
    );

  it("counts a Phase 8 anchor with a title as fully formed, and as neither bare nor anchorless", () => {
    const items = itemAnchoredWith("→ Phase 8 Gateway checkout and settlement.");

    expect(canonicalAnchoredLiveIds(items)).toEqual(["A-D1"]);
    expect(bareAnchoredLiveIds(items)).toEqual([]);
    expect(anchorlessLiveIds(items)).toEqual([]);
  });

  it("counts a Phase 8 title that begins with a digit", () => {
    const items = itemAnchoredWith("→ Phase 8 2FA hardening.");

    expect(canonicalAnchoredLiveIds(items)).toEqual(["A-D1"]);
  });

  it("still counts a step and block anchor", () => {
    const items = itemAnchoredWith("→ Step 7.8 Block A.");

    expect(canonicalAnchoredLiveIds(items)).toEqual(["A-D1"]);
  });

  it.each([
    "→ Phase 8",
    "→ Phase 8.",
    "→ Phase 8 —",
    "→ Phase 8: Title",
    "→ Phase 80 Title",
    "→ phase 8 Title",
    "→ Phase 9 Title",
    "→ TBD",
  ])("does not count %s as fully formed, though it is anchored", (anchor) => {
    const items = itemAnchoredWith(anchor);

    expect(liveIds(items)).toEqual(["A-D1"]);
    expect(canonicalAnchoredLiveIds(items)).toEqual([]);
    expect(anchorlessLiveIds(items)).toEqual([]);
  });

  it("counts a Phase 8 title that runs past the 80 characters the anchor is cut to", () => {
    const title = "Gateway checkout and settlement ".repeat(5).trim();
    const items = itemAnchoredWith(`→ Phase 8 ${title}.`);

    expect(title.length).toBeGreaterThan(80);
    expect(canonicalAnchoredLiveIds(items)).toEqual(["A-D1"]);
  });

  it("lets a newly filed item anchored to Phase 8 and a title through gate (a)", () => {
    const before = itemsOf(
      "phase-eight-before.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n",
    );
    const after = itemsOf(
      "phase-eight-after.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n\n" +
        "- **A-D2 [LOW]** → Phase 8 Dark mode.\n",
    );

    expect(newlyFiledWithoutStepAnchor(before, after)).toEqual([]);
  });

  it.each(["→ Phase 8", "→ TBD"])("stops a newly filed item anchored %s at gate (a)", (anchor) => {
    const before = itemsOf(
      "phase-eight-before.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n",
    );
    const after = itemsOf(
      "phase-eight-after.md",
      `## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n\n- **A-D2 [LOW]** ${anchor}\n`,
    );

    expect(newlyFiledWithoutStepAnchor(before, after).map((item) => item.id)).toEqual(["A-D2"]);
  });
});

describe("what the close gates on", () => {
  // Gate (a): an item the close UNDER PROCESSING files must carry a step anchor. The comparison is
  // against the register as it stood before, so pre-existing debt never fails the gate.
  it("finds a newly filed live item that carries no step anchor", () => {
    const before = itemsOf(
      "before.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n",
    );
    const after = itemsOf(
      "after.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n\n- **A-D2 [HIGH]** New and bare.\n",
    );

    expect(newlyFiledWithoutStepAnchor(before, after).map((item) => item.id)).toEqual(["A-D2"]);
  });

  it("does not fail a close on debt that already existed", () => {
    const before = itemsOf(
      "before2.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old and bare.\n",
    );
    const after = itemsOf(
      "after2.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old and bare.\n\n- **A-D2** → Step 1.2 Block A. New and anchored.\n",
    );

    expect(newlyFiledWithoutStepAnchor(before, after)).toEqual([]);
  });

  // Gate (c): an item the register declares discharged must say so on its anchor line, which is
  // where a reader looking at the item will be.
  it("finds a discharged item whose anchor line carries no mark", () => {
    const items = itemsOf(
      "unmarked.md",
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** → Step 7.7. Owed.\n\n" +
        "## Known Debt (Step 1.2)\n\n### Discharged by this block\n\n- **A-D1 [DISCHARGED]** Done.\n",
    );

    expect(dischargedWithoutMark(items).map((item) => item.id)).toEqual(["A-D1"]);
  });

  /**
   * Rule 33. The baseline gate (a) compares against is the doc lane's last commit, so the wiring
   * has to be proven against a real repository rather than two censuses built by hand — the
   * hand-built pair is what the two tests above prove, and this one proves that the thing the CLI
   * actually reads is that pair.
   */
  it("reads gate (a)'s baseline from the committed revision", () => {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(
      join(repo, "open-debt.md"),
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n",
    );
    execFileSync("git", ["-C", repo, "add", "open-debt.md"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=census@example.com",
      "-c",
      "user.name=Census",
      "commit",
      "-qm",
      "before",
    ]);
    writeFileSync(
      join(repo, "open-debt.md"),
      "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1** Old.\n\n- **A-D2 [HIGH]** New and bare.\n",
    );

    const baseline = committedRegister(repo, "open-debt.md");
    const before = censusDebtItemsFromText(baseline.text, "open-debt.md");
    const after = censusDebtItems([join(repo, "open-debt.md")]);

    expect(newlyFiledWithoutStepAnchor(before, after).map((item) => item.id)).toEqual(["A-D2"]);
    expect(baseline.revision).toMatch(/^[0-9a-f]{7,}$/);
  });

  // A baseline that cannot be read is a refusal. Reporting no newly filed items would make the gate
  // vacuous exactly when it has lost its subject, and the report would read green.
  it("refuses a baseline the repository cannot answer for", () => {
    expect(() => committedRegister(repo, "absent.md")).toThrow(RegisterRefusal);
  });

  it("does not ask for a mark on an item with no anchor line", () => {
    const items = itemsOf(
      "noanchor.md",
      "## Known Debt (Step 1.2)\n\n### Discharged by this block\n\n- **A-D1 [DISCHARGED]** Done.\n",
    );

    expect(dischargedWithoutMark(items)).toEqual([]);
  });
});

/**
 * Rule 38. A register the census cannot read is refused rather than skipped, because a skipped item
 * leaves the population silently and every count below it stays green while measuring less.
 */
describe("what the census refuses to classify", () => {
  it("refuses an item whose severity bracket is never closed", () => {
    const message = refusalFrom(
      "bracket.md",
      "## Known Debt (Step 1.1)\n\n- **A-D1 [HIGH Something is owed.\n",
    );

    expect(message).toMatch(/bracket\.md:3: the severity bracket is never closed/);
  });

  it("refuses an item whose bold run is never closed", () => {
    const message = refusalFrom(
      "bold.md",
      "## Known Debt (Step 1.1)\n\n- **A-D1 [HIGH] Something is owed.\n",
    );

    expect(message).toMatch(/bold\.md:3: the bold run is never closed/);
  });

  it("refuses a register that cannot be read", () => {
    expect(() => censusDebtItems([join(workspace, "absent.md")])).toThrow(RegisterRefusal);
  });

  it("refuses by name a register file that cannot be read among readable ones", () => {
    const readable = join(workspace, "readable.md");
    const absent = join(workspace, "absent-second.md");
    writeFileSync(readable, "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** Owed.\n");

    expect(() => censusDebtItems([readable, absent])).toThrow(RegisterRefusal);
    expect(() => censusDebtItems([readable, absent])).toThrow(/absent-second\.md/);
    expect(() => censusSkippedBullets([readable, absent])).toThrow(/absent-second\.md/);
  });
});

describe("a register held in more than one file", () => {
  const first = join(workspace, "first.md");
  const second = join(workspace, "second.md");
  writeFileSync(
    first,
    "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** Owed.\n  Second line.\n\n" +
      "- **Stray label** a bullet the census cannot read as an item.\n",
  );
  writeFileSync(
    second,
    "## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D2 [HIGH]** Done.\n\n" +
      "- **Another stray** a second label.\n",
  );

  it("reads the files as one population and keeps each item's own file", () => {
    const items = censusDebtItems([first, second]);

    expect(items.map((item) => [item.id, item.file])).toEqual([
      ["A-D1", first],
      ["A-D2", second],
    ]);
  });

  it("records the last line of every entry and bullet", () => {
    const [item] = censusDebtItems([first]);
    const [bullet] = censusSkippedBullets([first]);

    expect([item?.line, item?.endLine]).toEqual([5, 6]);
    expect([bullet?.line, bullet?.endLine]).toEqual([8, 8]);
  });

  it("names the file of every bullet it skips, so two files cannot collide on a line", () => {
    const bullets = censusSkippedBullets([first, second]);

    expect(bullets.map((bullet) => [bullet.file, bullet.id, bullet.line])).toEqual([
      [first, "Stray", 8],
      [second, "Another", 7],
    ]);
  });

  it("prints the skipped members with the file they sit in", () => {
    const measured = measureRegister([first, second], second, DECISION_LOG).find(
      (measurement) =>
        measurement.obligation.what === "register bullets whose head id is not a register id",
    );

    expect(measured?.members).toEqual([`${first}:Stray:8`, `${second}:Another:7`]);
  });
});

describe("the archive obligation", () => {
  const archiveOwing = "live debt entries filed in the archive file";
  const live = join(workspace, "archive-live.md");
  const archive = join(workspace, "archive-file.md");
  writeFileSync(live, "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** Owed.\n");

  const measuredWith = (archiveText: string): number | undefined => {
    writeFileSync(archive, archiveText);
    const found = measureRegister([live, archive], archive, DECISION_LOG).find(
      (measurement) => measurement.obligation.what === archiveOwing,
    );
    return found?.measured;
  };

  it("reads zero when the archive holds only finished entries", () => {
    expect(
      measuredWith(
        "## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D2 [HIGH]** → Step 1.1 · DISCHARGED 2026-01-01.\n",
      ),
    ).toBe(0);
  });

  it("reads one when a live entry is filed in the archive", () => {
    expect(
      measuredWith("## Known Debt (Step 1.0)\n\n### Open\n\n- **A-D2 [HIGH]** Still owed.\n"),
    ).toBe(1);
  });

  it("does not count the live file's own live entries", () => {
    expect(measuredWith("# OPEN DEBT ARCHIVE\n")).toBe(0);
  });

  it("is held at exactly zero", () => {
    const obligation = REGISTER_OBLIGATIONS.find((candidate) => candidate.what === archiveOwing);

    expect([obligation?.bound, obligation?.direction]).toEqual([0, "exact"]);
  });

  it("refuses an archive file that is not among the register files", () => {
    expect(() => measureRegister([live], archive, DECISION_LOG)).toThrow(RegisterRefusal);
  });

  it("refuses an archive file that cannot be read", () => {
    const absent = join(workspace, "absent-archive.md");

    expect(() => measureRegister([live, absent], absent, DECISION_LOG)).toThrow(
      /absent-archive\.md/,
    );
  });
});

/**
 * Rule 33. The baseline, the file list and the refusals live in the command's own body, so they are
 * exercised by running the command over a scratch lane: a docs repository with a committed baseline
 * and a working tree that has moved on from it.
 */
describe("the register gate as a process", () => {
  const OLD = "## Known Debt (Step 1.0)\n\n### Discharged\n\n- **A-D5 [LOW]** Finished.\n";
  const LIVE =
    "## Known Debt (Step 1.1)\n\n### Open\n\n- **A-D1 [HIGH]** → Step 1.2 Block A. Owed.\n";
  const ARCHIVE_PATH = "archive/project/open-debt-archive.md";
  const REGISTER_PATH = "project/open-debt.md";

  type Lane = { directory: string; docs: string };

  /** A lane whose docs repository has committed `committed` and whose tree then holds `working`. */
  const laneWith = (
    committed: Partial<Record<string, string>>,
    working: Partial<Record<string, string | null>>,
  ): Lane => {
    const directory = mkdtempSync(join(workspace, "lane-"));
    const docs = join(directory, "docs");
    mkdirSync(docs);
    symlinkSync(join(process.cwd(), "node_modules"), join(directory, "node_modules"));
    execFileSync("git", ["-C", docs, "init", "-q"]);

    const place = (relative: string, text: string | null) => {
      const target = join(docs, relative);
      mkdirSync(dirname(target), { recursive: true });
      if (text === null) rmSync(target, { force: true });
      else writeFileSync(target, text);
    };
    copyOf("project/decision-log.md", place);
    copyOf(".claude/commands/close-step.md", place);
    for (const [relative, text] of Object.entries(committed)) place(relative, text ?? null);

    execFileSync("git", ["-C", docs, "add", "-A"]);
    execFileSync("git", [
      "-C",
      docs,
      "-c",
      "user.email=census@example.com",
      "-c",
      "user.name=Census",
      "commit",
      "-qm",
      "baseline",
    ]);
    for (const [relative, text] of Object.entries(working)) place(relative, text ?? null);
    return { directory, docs };
  };

  const copyOf = (relative: string, place: (relative: string, text: string) => void) => {
    const source = join(process.cwd(), "docs", relative);
    const target = join(workspace, "copy.tmp");
    copyFileSync(source, target);
    place(relative, readFileSync(target, "utf8"));
  };

  const runGate = (lane: Lane) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "scripts/project/verify-register.ts")],
      { cwd: lane.directory, encoding: "utf8" },
    );
    return { status: result.status, out: result.stdout, err: result.stderr };
  };

  it("prints the archive among the files it reads", () => {
    const lane = laneWith({ [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD }, {});

    expect(runGate(lane).out).toContain(`register archive  docs/${ARCHIVE_PATH}`);
  }, 30_000);

  it("prints a line for the archive obligation like the others", () => {
    const lane = laneWith({ [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD }, {});

    expect(runGate(lane).out).toMatch(/PASS\s+0\s+live debt entries filed in the archive file/);
  }, 30_000);

  it("fails the close when a live entry is filed in the archive", () => {
    const planted = `${OLD}\n### Open\n\n- **A-D6 [HIGH]** → Step 1.2 Block A. Still owed.\n`;
    const lane = laneWith(
      { [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD },
      { [ARCHIVE_PATH]: planted },
    );

    const gate = runGate(lane);

    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(/FAIL\s+1\s+live debt entries filed in the archive file\s+\(up 1\)/);
  }, 30_000);

  it("treats an id the committed archive holds as already filed", () => {
    const refiled = `${LIVE}\n- **A-D5 [LOW]** No anchor at all.\n`;
    const lane = laneWith(
      { [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD },
      { [REGISTER_PATH]: refiled },
    );

    expect(runGate(lane).out).toMatch(
      /PASS\s+a live item filed since docs@[0-9a-f]+ names a step \(0 filed\)/,
    );
  }, 30_000);

  it("still judges an id no committed file holds", () => {
    const fresh = `${LIVE}\n- **A-D7 [LOW]** No anchor at all.\n`;
    const lane = laneWith(
      { [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD },
      { [REGISTER_PATH]: fresh },
    );

    expect(runGate(lane).out).toMatch(
      /FAIL\s+a live item filed since docs@[0-9a-f]+ names a step \(1 filed\)/,
    );
  }, 30_000);

  it("refuses an archive file missing from the working tree", () => {
    const lane = laneWith({ [REGISTER_PATH]: LIVE, [ARCHIVE_PATH]: OLD }, { [ARCHIVE_PATH]: null });

    const gate = runGate(lane);

    expect(gate.status).toBe(1);
    expect(gate.err).toContain(`docs/${ARCHIVE_PATH}:0: the register could not be read`);
  }, 30_000);

  it("refuses an archive file the committed revision does not hold", () => {
    const lane = laneWith({ [REGISTER_PATH]: LIVE }, { [ARCHIVE_PATH]: OLD });

    const gate = runGate(lane);

    expect(gate.status).toBe(1);
    expect(gate.err).toContain(`${ARCHIVE_PATH}:0: the committed revision could not be read`);
  }, 30_000);
});

describe("what the decision log reader covers", () => {
  it("reads a row that sits in a table", () => {
    const records = recordsOf(
      "table.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | A thing | accepted | 2026-01-01 | N/A |\n",
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.row.id).toBe("DEC-0001");
  });

  // Markdown ends a table at the first blank line, so every row after it stops being a row. The
  // real log has one blank line at :369 and 96 rows behind it.
  it("reads a row a blank line left outside every table", () => {
    const records = recordsOf(
      "orphan.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | A thing | accepted | 2026-01-01 | N/A |\n" +
        "\n" +
        "| DEC-0002 | Another | accepted | 2026-01-02 | DEC-0001 |\n",
    );

    expect(records.map((record) => record.row.id)).toEqual(["DEC-0001", "DEC-0002"]);
    expect(orphanedDecisionRows("a\n| DEC-0002 | x |\n", "orphan.md")).toHaveLength(1);
  });

  // The real log glues DEC-0123 onto DEC-0122 with `||` where a line break belongs. Reading only
  // the first cell of that line loses DEC-0123, and then makes DEC-0124's reference to it look
  // like a reference to an id with no record at all.
  it("reads a record the log glued onto another record's line", () => {
    const records = recordsOf(
      "glued.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | A thing | accepted | 2026-01-01 | N/A || DEC-0002 | Another | accepted | 2026-01-02 | N/A |\n",
    );

    expect(records.map((record) => record.row.id)).toEqual(["DEC-0001", "DEC-0002"]);
    expect(gluedRecords(records).map((record) => record.row.id)).toEqual(["DEC-0002"]);
    expect(supersedesFindings(records)).toEqual([]);
  });

  // The template table is a form, not a record of anything. It is excluded by its heading, which
  // is a declared property; no id is tested against a pattern, because the seeded table holds two
  // rows with a NOTE- id and a pattern test would drop them without saying so.
  it("excludes the template table and keeps a row whose id is not a DEC id", () => {
    const records = recordsOf(
      "template.md",
      "## Decision Template\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-XXXX | [short title] | proposed | [YYYY-MM-DD] | [DEC-YYYY or N/A] |\n" +
        "\n" +
        "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| NOTE-1.1-CLOSE | A note | accepted | 2026-01-01 | N/A |\n",
    );

    expect(records.map((record) => record.row.id)).toEqual(["NOTE-1.1-CLOSE"]);
  });

  it("finds a Date cell that holds something other than a date", () => {
    const records = recordsOf(
      "dates.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | A thing | accepted | accepted | N/A |\n",
    );

    expect(rowsWithNonDate(records).map((row) => row.id)).toEqual(["DEC-0001"]);
  });

  it("finds a row whose cells do not match its columns", () => {
    const records = recordsOf(
      "cells.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | `a` || `b` | accepted | 2026-01-01 | N/A |\n",
    );

    expect(rowsOffColumnCount(records).map((record) => record.row.id)).toEqual(["DEC-0001"]);
  });

  /**
   * The column is prose. Reading every id out of a sentence invented seven supersede defects that
   * the sentences do not claim — "Extends DEC-0108's model", "Paired with DEC-0132" — so a claim is
   * read only where the cell holds nothing but an id, which is one cell in the real log.
   */
  it("reads a supersede claim only from a cell holding nothing but an id", () => {
    const records = recordsOf(
      "supersede.md",
      "## Seeded Decisions\n\n" +
        "| Decision ID | Title | Status | Date | Supersedes |\n" +
        "| --- | --- | --- | --- | --- |\n" +
        "| DEC-0001 | Reverse | accepted | 2026-01-01 | DEC-0002 |\n" +
        "| DEC-0002 | Prose, newer id | accepted | 2026-01-02 | Paired with DEC-0009 |\n" +
        "| DEC-0003 | Forward | accepted | 2026-01-03 | DEC-0001 |\n",
    );

    expect(supersedeClaimOf(records[1]!)).toBeNull();
    expect(
      supersedesFindings(records).map((found) => [found.row.id, found.referenced, found.kind]),
    ).toEqual([["DEC-0001", "DEC-0002", "names-newer"]]);
  });
});

/**
 * The ratchets, asserted against the real registers.
 *
 * EXACT bounds force both halves. A register that gains an item exceeds its literal and fails; a
 * register whose debt is paid down drops below it and ALSO fails, so paying debt down forces the
 * number down in the same commit instead of quietly leaving headroom for new debt. That is right
 * for a count of DEFECTS, where every instance is meant to be driven to zero.
 *
 * FLOOR bounds are for a count that RISES as the register improves — a canonicalised anchor raises
 * the anchored population, and a legitimate improvement must not fail a close. A floor fails only
 * on a fall, which is the direction that loses coverage without saying so.
 *
 * The gate's CLI reads the same literals through the same dispatcher, so the test and the gate
 * cannot drift.
 */
describe("the register ratchets", () => {
  for (const obligation of REGISTER_OBLIGATIONS) {
    if (obligation.bound === null) continue;
    const bound = obligation.bound;

    if (obligation.direction === "floor") {
      it(`${obligation.what} — at least ${bound}`, () => {
        expect(measuredFor(obligation.what)).toBeGreaterThanOrEqual(bound);
      });
      continue;
    }

    it(`${obligation.what} — exactly ${bound}`, () => {
      expect(measuredFor(obligation.what)).toBe(bound);
    });
  }

  // An obligation with no detector is a bound nothing measures. The dispatcher throws for it
  // rather than reporting zero, and this is the test that surfaces which one is unwired.
  it("wires a detector for every obligation it declares", () => {
    expect(measurements()).toHaveLength(REGISTER_OBLIGATIONS.length);
  });

  // A null bound is the one place an assertion can be removed without anything going red, so the
  // set that carries one is named here. An assertion demoted to a report is a deliberate edit, not
  // something a later change can do in passing, and this test is what makes that true.
  it("reports exactly one obligation without asserting it, and names it", () => {
    const reported = REGISTER_OBLIGATIONS.filter((obligation) => obligation.bound === null);
    expect(reported.map((obligation) => obligation.what)).toEqual([
      "decision-log supersede claims naming a newer decision than their own row",
    ]);
  });

  // A floor is the one bound that can be loosened without anything going red, so the set that
  // carries one is named for the same reason the reported obligation is: switching a pin to a
  // floor has to be an edit to this list, not something a later change does in passing.
  it("holds exactly two obligations as floors, and names them", () => {
    const floors = REGISTER_OBLIGATIONS.filter((obligation) => obligation.direction === "floor");
    expect(floors.map((obligation) => obligation.what)).toEqual([
      "live debt ids carrying an anchor that names a step and a block",
      "decision-log Supersedes cells holding nothing but an id",
    ]);
  });
});

let cached: RegisterMeasurement[] | null = null;
const measurements = (): RegisterMeasurement[] => {
  cached ??= measureRegister([OPEN_DEBT, OPEN_DEBT_ARCHIVE], OPEN_DEBT_ARCHIVE, DECISION_LOG);
  return cached;
};

const measuredFor = (what: string): number => {
  const found = measurements().find((measurement) => measurement.obligation.what === what);
  if (found === undefined) {
    throw new Error(`no measurement is wired for the obligation ${JSON.stringify(what)}`);
  }
  return found.measured;
};
