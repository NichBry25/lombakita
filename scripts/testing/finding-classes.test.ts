// The declaration and the population, pinned against each other.
//
// The table in finding-classes.mjs is what the browser audits say they can find. This asserts that
// it is also what they DO find — that no class is emitted without being declared, and no class is
// declared without being emitted. Adding a finding class without extending the table is meant to be
// a build failure, and this is the half of that which fails at build time rather than at run time.
//
// Resolved against the parsed syntax tree rather than a line window: a grep for `finding("` cannot
// tell a call from the same text inside a comment or a template string, and this file exists
// because instruments that cannot tell those apart are what the step is repairing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { FINDING_CLASSES } from "./finding-classes.mjs";

const AUDITS = ["scripts/testing/mobile-audit.mjs", "scripts/testing/contrast-audit.mjs"];

/** Every class name passed as the first argument of a `finding(...)` call in `path`. */
const classesEmittedBy = (path: string): string[] => {
  const source = readFileSync(join(process.cwd(), path), "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "finding"
    ) {
      const first = node.arguments[0];
      // A computed class name would defeat the whole pin, so it is a failure rather than a skip.
      expect(
        first && ts.isStringLiteralLike(first),
        `${path}: finding() called with a computed class`,
      ).toBe(true);
      found.push((first as ts.StringLiteralLike).text);
    }
    node.forEachChild(walk);
  };

  tree.forEachChild(walk);
  return found;
};

const emitted = new Set(AUDITS.flatMap(classesEmittedBy));

describe("FINDING_CLASSES declares exactly what the audits emit", () => {
  it("declares every class the audits emit", () => {
    for (const className of emitted) {
      expect(Object.keys(FINDING_CLASSES), `"${className}" is emitted but not declared`).toContain(
        className,
      );
    }
  });

  it("emits every class it declares", () => {
    for (const className of Object.keys(FINDING_CLASSES)) {
      expect([...emitted], `"${className}" is declared but nothing emits it`).toContain(className);
    }
  });

  // Named individually so a deletion reads as a deletion in the diff rather than as a count change.
  it("covers the five classes this step is accountable for", () => {
    expect(Object.keys(FINDING_CLASSES).sort()).toEqual([
      "contrast",
      "overflow",
      "target",
      "tone",
      "wide",
    ]);
  });
});

describe("every declared class measures how bad its finding is", () => {
  it.each(Object.entries(FINDING_CLASSES))("%s carries a complete declaration", (_name, entry) => {
    expect(entry.audit).toMatch(/^(mobile-audit|contrast-audit)$/);
    expect(entry.describes.length).toBeGreaterThan(0);
    expect(entry.unit.length).toBeGreaterThan(0);
    expect(entry.metric).toMatch(/^(raw|deficit)$/);
    expect(typeof entry.magnitudeOf).toBe("function");
  });

  it.each(Object.entries(FINDING_CLASSES))("%s computes its declared example", (_name, entry) => {
    expect(entry.magnitudeOf(entry.example.measurement)).toBe(entry.example.magnitude);
  });
});

// The invariant the whole table rests on, and the one a new class is most likely to get wrong: a
// contrast ratio and a tone separation both get WORSE as they fall, so storing the reading would
// invert the comparison and pass every regression. Storing the shortfall keeps one direction.
describe("higher is worse, for every class", () => {
  const WORSENING = {
    overflow: [{ scrollWidth: 400 }, { scrollWidth: 900 }],
    wide: [
      { right: 400, left: 0, viewport: 390 },
      { right: 900, left: 0, viewport: 390 },
    ],
    target: [
      { width: 40, height: 44 },
      { width: 12, height: 12 },
    ],
    contrast: [
      { need: 4.5, ratio: 4 },
      { need: 4.5, ratio: 1.1 },
    ],
    tone: [
      { need: 10, separation: 9.92 },
      { need: 10, separation: 0.5 },
    ],
  } satisfies Record<string, [Record<string, number>, Record<string, number>]>;

  it("has a worsening pair for every declared class", () => {
    expect(Object.keys(WORSENING).sort()).toEqual(Object.keys(FINDING_CLASSES).sort());
  });

  it.each(Object.entries(WORSENING))("%s grows as the finding gets worse", (name, [bad, worse]) => {
    const entry = FINDING_CLASSES[name]!;
    expect(entry.magnitudeOf(worse)).toBeGreaterThan(entry.magnitudeOf(bad));
  });

  // A reading exactly at the threshold is a shortfall of nothing, which is what makes the deficit
  // form comparable across classes rather than merely monotonic within one.
  it.each(Object.entries(FINDING_CLASSES).filter(([, e]) => e.metric === "deficit"))(
    "%s is zero at its threshold",
    (name, entry) => {
      const atThreshold: Record<string, Record<string, number>> = {
        target: { width: 44, height: 44 },
        contrast: { need: 4.5, ratio: 4.5 },
        tone: { need: 10, separation: 10 },
      };

      expect(entry.magnitudeOf(atThreshold[name]!)).toBe(0);
    },
  );
});

// A left-overflowing element does not raise the document's scrollWidth, so the page-level
// `overflow` finding cannot see it. Before `wide` carried a magnitude, nothing measured it at all.
describe("wide measures the edge the page-level finding cannot see", () => {
  it("measures an element hanging off the left", () => {
    expect(FINDING_CLASSES.wide!.magnitudeOf({ right: 100, left: -40, viewport: 390 })).toBe(40);
  });

  it("measures an element inside both edges as zero", () => {
    expect(FINDING_CLASSES.wide!.magnitudeOf({ right: 380, left: 10, viewport: 390 })).toBe(0);
  });
});
