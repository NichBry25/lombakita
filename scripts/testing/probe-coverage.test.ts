// The probe harness's declared subject, pinned against the probes that exist.
//
// Rule 36 clause 1 says a probe's mutation must be shown to COMPILE, and it was a field a probe
// could simply not fill in: eight of thirteen did not, including two that mutate TypeScript with a
// vitest detector — which fails identically on a type error and on a guard holding, so those probes
// could not say which of the two they had observed. The clause is now derived from the file
// extension, and an extension in neither table is a refusal rather than a wave-through.
//
// This asserts the declaration covers the population: every file every probe mutates resolves to a
// declared check, and every probe carries the rest of what Rule 36 asks for.

import { describe, expect, it } from "vitest";
import {
  CODE_CHECKS,
  DATA_CHECKS,
  compileCheckFor,
  isCodeFile,
  runProbe,
  substituteOnce,
} from "./guard-probe.mjs";
import type { Probe } from "./guard-probe.mjs";
import { probes as configGateProbes } from "./probes/config-gates.mjs";
import { probes as browserAuditProbes } from "./probes/browser-audit-refusals.mjs";

const SUITES: Record<string, Probe[]> = {
  "config-gates": configGateProbes,
  "browser-audit-refusals": browserAuditProbes,
};

const everyProbe: [string, Probe][] = Object.entries(SUITES).flatMap(([suite, probes]) =>
  probes.map((probe): [string, Probe] => [`${suite}: ${probe.name}`, probe]),
);

const GUARD_CLASSES = ["A1-in", "A1-pre", "A2", "B", "C", "D"];

describe("the probe suites", () => {
  it("both contain probes", () => {
    for (const [suite, probes] of Object.entries(SUITES)) {
      expect(probes.length, `${suite} has no probes`).toBeGreaterThan(0);
    }
  });

  it("import as data without running anything", () => {
    // Reaching this assertion at all is the proof: a suite that ran on import would have mutated
    // the tree and restored it before vitest got here, which is not something a test may do.
    expect(everyProbe.length).toBeGreaterThan(0);
  });
});

describe.each(everyProbe)("%s", (_label, probe) => {
  // Clause 8: the harmful move is identified BEFORE the detector is chosen, and the class is what
  // says which detector is admissible. A probe missing either has not made that decision.
  it("names its guard class and the harmful move", () => {
    expect(GUARD_CLASSES).toContain(probe.klass);
    expect(probe.harmfulMove.length).toBeGreaterThan(0);
  });

  // Clause 5: an explicit file list, never path-less.
  it("lists the files it mutates explicitly", () => {
    expect(probe.files.length).toBeGreaterThan(0);
    for (const file of probe.files) {
      expect(file).not.toMatch(/[*?]/);
      expect(file.startsWith("/")).toBe(false);
    }
  });

  // Clause 2: the mutation has to be observable on disk afterwards.
  it("declares a marker proving the mutation applied", () => {
    expect(probe.appliedMarkers.length).toBeGreaterThan(0);
  });

  // Clause 1: every file it touches resolves to a declared check, so the harness never has to
  // decide at run time whether something counts as code.
  it("mutates only files this repository knows how to compile-check", () => {
    for (const file of probe.files) {
      expect(() => compileCheckFor(file), `no declared check for ${file}`).not.toThrow();
    }
  });
});

describe("the compile-check declaration", () => {
  it("refuses an extension nobody has classified", () => {
    expect(() => compileCheckFor("scripts/testing/whatever.unknown")).toThrow(/no compile check/);
  });

  it("treats source files as code and data files as data", () => {
    expect(isCodeFile("a.mjs")).toBe(true);
    expect(isCodeFile("a.ts")).toBe(true);
    expect(isCodeFile("a.css")).toBe(true);
    expect(isCodeFile("a.json")).toBe(false);
    expect(isCodeFile(".github/workflows/ci.yml")).toBe(false);
  });

  it("covers every extension the probes actually mutate", () => {
    const declared = new Set([...Object.keys(CODE_CHECKS), ...Object.keys(DATA_CHECKS)]);
    const used = new Set(
      everyProbe.flatMap(([, probe]) => probe.files.map((f) => f.slice(f.lastIndexOf(".")))),
    );

    for (const extension of used) {
      expect([...declared], `${extension} is mutated but not declared`).toContain(extension);
    }
  });
});

/**
 * Clause 1 ENFORCED, not merely present.
 *
 * A probe used to declare its own `compiles` or none at all, and "none at all" was the common case.
 * The clause is now derived from the extension and runs before the detector, so a mutation that
 * does not parse is a refusal rather than a verdict. This runs the real harness against a real
 * unparseable mutation and requires it to throw before the detector — which is written to report
 * the guard as PROVEN — can be reached.
 */
describe("clause 1 runs whether or not a probe declares it", () => {
  const FIXTURE = "scripts/testing/probes/fixtures/parses.mjs";

  it("refuses a mutation that does not parse, before running the detector", async () => {
    let detectorRan = false;

    await expect(
      runProbe({
        name: "clause-1 self-probe",
        klass: "D",
        harmfulMove: "believing a detector that went red because the mutation was not valid syntax",
        files: [FIXTURE],
        appliedMarkers: ["const = ;"],
        mutate: () => substituteOnce(FIXTURE, "export const intact = true;", "const = ;"),
        detect: async () => {
          detectorRan = true;
          return { refused: true, evidence: "reported PROVEN without the mutation parsing" };
        },
      }),
    ).rejects.toThrow(/--check/);

    expect(detectorRan, "the detector ran despite the mutation not parsing").toBe(false);
  });
});
