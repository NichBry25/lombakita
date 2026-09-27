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

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_CHECKS,
  DATA_CHECKS,
  compileCheckFor,
  isCodeFile,
  runProbe,
  substituteOnce,
} from "./guard-probe.mjs";
import { fails, refusedWhen, run } from "./probes/detectors.mjs";
import type { Probe } from "./guard-probe.mjs";
import { probes as configGateProbes } from "./probes/config-gates.mjs";
import { probes as browserAuditProbes } from "./probes/browser-audit-refusals.mjs";
import { probes as shellContentProbes } from "./probes/shell-content.mjs";
import { probes as emailFailureProbes } from "./probes/email-failure-visibility.mjs";
import { probes as fixtureRecipientProbes } from "./probes/fixture-recipients.mjs";
import { probes as registrationRateLimitProbes } from "./probes/registration-rate-limit.mjs";
import { probes as schemaDriftProbes } from "./probes/schema-drift.mjs";
import { probes as resetGuardProbes } from "./probes/reset-guard.mjs";
import { probes as reindexGuardProbes } from "./probes/reindex-guard.mjs";
import { probes as seedGuardProbes } from "./probes/seed-guard.mjs";
import { probes as harnessGuardProbes } from "./probes/harness-guard.mjs";
import { probes as registerGateProbes } from "./probes/register-gate.mjs";
import { probes as backfillRejectedBatchProbes } from "./probes/backfill-rejected-batch.mjs";
import { probes as priceClaimProbes } from "./probes/price-claim.mjs";
import { probes as harnessPreconditionProbes } from "./probes/harness-preconditions.mjs";
import { probes as decConformanceProbes } from "./probes/dec-conformance.mjs";
import { probes as deletionInstrumentProbes } from "./probes/deletion-instruments.mjs";
import { probes as deletionResidueSectionProbes } from "./probes/deletion-residue-section.mjs";

const SUITES: Record<string, Probe[]> = {
  "config-gates": configGateProbes,
  "browser-audit-refusals": browserAuditProbes,
  "shell-content": shellContentProbes,
  "email-failure-visibility": emailFailureProbes,
  "fixture-recipients": fixtureRecipientProbes,
  "registration-rate-limit": registrationRateLimitProbes,
  "schema-drift": schemaDriftProbes,
  "reset-guard": resetGuardProbes,
  "reindex-guard": reindexGuardProbes,
  "seed-guard": seedGuardProbes,
  "harness-guard": harnessGuardProbes,
  "register-gate": registerGateProbes,
  "backfill-rejected-batch": backfillRejectedBatchProbes,
  "price-claim": priceClaimProbes,
  "harness-preconditions": harnessPreconditionProbes,
  "dec-conformance": decConformanceProbes,
  "deletion-instruments": deletionInstrumentProbes,
  "deletion-residue-section": deletionResidueSectionProbes,
};

const everyProbe: [string, Probe][] = Object.entries(SUITES).flatMap(([suite, probes]) =>
  probes.map((probe): [string, Probe] => [`${suite}: ${probe.name}`, probe]),
);

// Rule 36 clause 8's control-flow classes, plus `value` for a property that is not a guard at all.
// A probe that mutates a sign or a constant has no position to move and no call to remove, so
// forcing it into a control-flow class asserts an ordering relationship the code does not have.
const GUARD_CLASSES = ["A1-in", "A1-pre", "A2", "B", "C", "D", "value"];

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

/**
 * The retry on a runner that never started, red for the reason claimed.
 *
 * `vitest`'s orchestrator timing out on its own worker exits 1 while reporting no case at all — the
 * same exit code and the same silence a mistyped test path produces. Reading that as a verdict in
 * either direction is the clause-3 failure `detectors.mjs` exists to prevent, so it is retried once.
 * A repair is a guard, and Rule 32 applies to it too: a retry nothing exercises is a claim, not an
 * enforcement. These drive both of its paths against a real subprocess rather than a fake result,
 * because the wiring being tested IS the call `fails` makes.
 */
describe("the retry on a runner that never started", () => {
  const FLAKY_RUNNER = "scripts/testing/probes/fixtures/flaky-runner.mjs";
  const marker = join(tmpdir(), `lombakita-flaky-runner-${process.pid}`);
  const namedFailure = /× a fake case/;

  beforeEach(() => {
    if (existsSync(marker)) unlinkSync(marker);
  });

  afterEach(() => {
    if (existsSync(marker)) unlinkSync(marker);
  });

  it("absorbs a worker timeout once the retry reaches a verdict", () => {
    // `once`: the first run crashes with the worker timeout and writes the marker; the retry names a
    // failing case. Without the retry this is the throw covered two tests below, so a pass here is
    // the wiring in `fails` being live rather than the helper merely existing.
    const verdict = fails("node", [FLAKY_RUNNER, marker, "once"], namedFailure);

    expect(verdict.refused).toBe(true);
    expect(verdict.evidence).toContain("a fake case");
  });

  it("still throws when the retry times out too", () => {
    // `always`: every run crashes, so the flake is not converted into a verdict.
    expect(() => fails("node", [FLAKY_RUNNER, marker, "always"], namedFailure)).toThrow(
      /A run that crashed is not a guard that refused/,
    );
  });

  it("leaves a caller that passes no retry throwing immediately", () => {
    // Every other caller of `refusedWhen` is unchanged: a crash is still a crash for them.
    expect(() =>
      refusedWhen(run("node", [FLAKY_RUNNER, marker, "always"]), {
        reached: namedFailure,
        label: "no-retry caller",
      }),
    ).toThrow(/A run that crashed is not a guard that refused/);
  });
});

/**
 * A detector matches a case marker that colour surrounds.
 *
 * LAUNCH-D169. A test runner writes the marker, then an SGR escape, then the space — measured as
 * `ESC[31m   ESC[31m×ESC[31m builds each join from the chain`. A detector anchored on `/× /`
 * therefore matches only where colour happens to be off, so the same probe set is green in CI and
 * red in a colour-forcing shell, and red in the one reading Rule 36 clause 3 forbids: it throws
 * "a run that crashed is not a guard that refused" for a run that measured fine.
 *
 * CI sets no FORCE_COLOR, so deleting the strip in `detectors.mjs` would go unnoticed there and
 * unnoticed by every probe suite this repository runs. This is the notice. The bytes below are the
 * measured ones and a real child writes them, read back through `run`, so the input arrives the way
 * a probe's does rather than being handed to the matcher.
 */
describe("a detector reading a case marker colour surrounds", () => {
  const MEASURED = "\u001b[31m   \u001b[31m×\u001b[31m builds each join from the chain 4ms\n";

  /** The detector as `deletion-instruments.mjs` spells it, over the run it actually waits on. */
  const CHAIN_DETECTOR = /× .*builds each join from the chain/;

  const colouredRun = () =>
    run("node", ["-e", `process.stdout.write(${JSON.stringify(MEASURED)}); process.exit(1);`]);

  it("matches through the escapes", () => {
    const verdict = refusedWhen(colouredRun(), {
      status: 1,
      reached: CHAIN_DETECTOR,
      label: "the deletion-residue detector",
    });

    expect(verdict.refused).toBe(true);
    expect(verdict.evidence).toContain("builds each join from the chain");
    // The escapes are still there on the way in, so this is the strip doing the matching and not a
    // child that happened not to colour its output.
    expect(colouredRun().stdout).toContain("\u001b[31m");
  });
});

/**
 * The register gate's detectors pin deltas, never figures.
 *
 * Two numbers in a line the gate prints are not the same kind of value. The FIGURE is what the gate
 * measured — a population read off a live register, so it moves every time an item is closed, and a
 * detector that spells it out stops matching while `detectors.mjs` throws over a fixture that has
 * stopped describing its subject (LAUNCH-D128, whose fifth instance was exactly this at
 * `register-gate.mjs`). A DEPARTURE — `(up 1)`, `(down 1 …)` — is what the probe's own mutation
 * caused, which is what makes the detector specific, and is the only figure worth pinning.
 *
 * The rule is therefore mechanical: in a pattern a register-gate detector waits on, a digit appears
 * only inside a departure, a character class or an escape. Source rather than convention, because a
 * convention is what let eight of these drift back to literals.
 */
describe("the register gate's detectors", () => {
  const REGISTER_GATE = "register-gate";

  const detectorPatterns = (detect: unknown): string[] =>
    [...String(detect).matchAll(/\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])*)\//g)].map(
      ([, body]) => body ?? "",
    );

  /** Everything that legitimately holds a digit: the departure, and the pattern syntax itself. */
  const DEPARTURE = /\\\((?:up|down)\s[^)]*\)/g;
  const CHARACTER_CLASS = /\[(?:\\.|[^\]\\])*\]/g;
  const ESCAPE = /\\./g;

  const figures = (pattern: string): string[] =>
    [
      ...pattern
        .replace(DEPARTURE, "")
        .replace(CHARACTER_CLASS, "")
        .replace(ESCAPE, "")
        .matchAll(/\d+/g),
    ].map(([figure]) => figure);

  it("carry no figure outside a departure", () => {
    const suite = SUITES[REGISTER_GATE] ?? [];
    let inspected = 0;

    for (const probe of suite) {
      for (const pattern of detectorPatterns(probe.detect)) {
        inspected += 1;
        const pinned = figures(pattern);

        expect(
          pinned,
          `${REGISTER_GATE}: ${probe.name} pins ${pinned.join(", ")} in /${pattern}/`,
        ).toEqual([]);
      }
    }

    expect(inspected, "no detector was inspected, so nothing was pinned").toBeGreaterThan(0);
  });
});
