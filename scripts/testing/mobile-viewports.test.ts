// The mobile audit's declared subject, pinned against the population it measured.
//
// The audit looked at 390px and nothing else, and 390 is the one phone width of the three where the
// institution-public pages do not overflow. "104/105 pages clean" was true of one screen and was
// read as true of mobile. MOBILE_VIEWPORTS is the declaration now, and these assertions are what
// make it one: a width cannot leave the set while the baseline still carries readings taken at it,
// and the set cannot gain a width without the baseline being re-taken across all of them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MOBILE, MOBILE_VIEWPORTS } from "./lib-browser.mjs";
import { baselinePath } from "./lib-audit-baseline.mjs";

const DECLARED = MOBILE_VIEWPORTS.map((viewport) => viewport.width);

const baseline = JSON.parse(readFileSync(baselinePath("mobile-audit"), "utf8")) as {
  note: string;
  findings: { key: string }[];
};

/** Finding keys read `<page>|<width>|<class>`, so the width is the second segment. */
const widthOf = (key: string): string => key.split("|")[1] ?? "";

describe("the mobile audit declares the widths it measures", () => {
  // Named individually so a deletion reads as a deletion in the diff rather than as a count change.
  it("measures the three widths the market is on", () => {
    expect(DECLARED).toEqual([360, 375, 390]);
  });

  it("gives every declared viewport a height to render into", () => {
    for (const viewport of MOBILE_VIEWPORTS) {
      expect(viewport.height).toBeGreaterThan(0);
    }
  });

  // The gallery script shoots one phone width. It has to be one the audit covers, and the widest is
  // the honest choice for a screenshot: anything narrower would picture a layout the audit is
  // separately reporting as broken.
  it("hands the single-viewport scripts the widest of the set", () => {
    expect(MOBILE).toBe(MOBILE_VIEWPORTS[MOBILE_VIEWPORTS.length - 1]);
    expect(MOBILE.width).toBe(Math.max(...DECLARED));
  });
});

describe("the declaration and the baseline describe the same run", () => {
  it("carries every recorded finding under a declared width", () => {
    for (const finding of baseline.findings) {
      expect(
        DECLARED.map(String),
        `${finding.key} was recorded at a width nothing declares`,
      ).toContain(widthOf(finding.key));
    }
  });

  it("was taken at exactly the declared widths", () => {
    const recorded = baseline.note.match(/^([\d/]+)px viewports/)?.[1];
    expect(
      recorded,
      `the baseline note does not open with the widths it was taken at: ${baseline.note.slice(0, 60)}`,
    ).toBeDefined();
    expect(recorded!.split("/").map(Number)).toEqual(DECLARED);
  });
});
