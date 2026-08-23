import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CURATED_DROP_FLAG,
  classifyAgainstBaseline,
  readBaseline,
  writeBaseline,
  type AuditFinding,
  type Baseline,
} from "./lib-audit-baseline.mjs";
import { finding } from "./finding-classes.mjs";

/**
 * A finding built the way the audits build one, so these tests exercise the shape `finishAudit`
 * actually receives. Hand-written object literals used to be enough here, and are now refused
 * outright — the declaration gate exists precisely to stop a finding reaching a baseline without a
 * class saying how its severity is measured.
 */
const overflowFinding = (key: string, scrollWidth: number): AuditFinding =>
  finding("overflow", key, { scrollWidth }) as AuditFinding;

const committedBaseline = (name: string): Baseline => readBaseline(name);

const baselineOf = (findings: AuditFinding[]): Baseline => ({
  takenAt: "2026-08-22T17:37:06.072Z",
  keys: new Set(findings.map((f) => f.key)),
  byKey: new Map(findings.map((f) => [f.key, f])),
});

describe("classifyAgainstBaseline", () => {
  it("reports a key the baseline has never seen as fresh", () => {
    const baseline = baselineOf([{ key: "a|overflow", magnitude: 400 }]);

    const { fresh, worsened } = classifyAgainstBaseline([{ key: "b|overflow" }], baseline);

    expect(fresh.map((f) => f.key)).toEqual(["b|overflow"]);
    expect(worsened).toEqual([]);
  });

  it("accepts a baselined finding measured at exactly what was recorded", () => {
    const baseline = baselineOf([{ key: "a|overflow", magnitude: 400 }]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [{ key: "a|overflow", magnitude: 400 }],
      baseline,
    );

    expect(fresh).toEqual([]);
    expect(worsened).toEqual([]);
  });

  // The defect this exists to close: the key alone said "this page overflows", so a page baselined
  // at 400px stayed baselined at 900px and the gate reported green over the regression.
  it("fails a baselined finding that measured worse than it was recorded at", () => {
    const baseline = baselineOf([{ key: "a|overflow", magnitude: 400 }]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [{ key: "a|overflow", magnitude: 900 }],
      baseline,
    );

    expect(fresh).toEqual([]);
    expect(worsened).toEqual([{ key: "a|overflow", was: 400, now: 900 }]);
  });

  it("does not fail a baselined finding that improved", () => {
    const baseline = baselineOf([{ key: "a|overflow", magnitude: 400 }]);

    const { worsened } = classifyAgainstBaseline([{ key: "a|overflow", magnitude: 391 }], baseline);

    expect(worsened).toEqual([]);
  });

  // Findings whose kind carries no measurable magnitude — a `wide` element, a contrast pairing —
  // are still compared by key alone, so adding magnitudes to one audit cannot break the others.
  it("compares by key alone when either side carries no magnitude", () => {
    const baseline = baselineOf([{ key: "a|wide|div.card" }]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [{ key: "a|wide|div.card", magnitude: 9000 }],
      baseline,
    );

    expect(fresh).toEqual([]);
    expect(worsened).toEqual([]);
  });

  it("reports a recorded key that did not reproduce as healed", () => {
    const baseline = baselineOf([{ key: "a|overflow", magnitude: 400 }, { key: "b|overflow" }]);

    const { healed } = classifyAgainstBaseline([{ key: "a|overflow", magnitude: 400 }], baseline);

    expect(healed).toEqual(["b|overflow"]);
  });
});

// Built through the real production path rather than a hand-made Map: the committed baseline file,
// read by the same `readBaseline` the audits call. A hand-built baseline would prove the comparison
// and say nothing about whether the recorded file actually carries the magnitudes to compare.
describe("the committed mobile-audit baseline", () => {
  it("carries a numeric magnitude on every overflow finding it records", () => {
    const baseline = committedBaseline("mobile-audit");
    const overflows = [...baseline.byKey.values()].filter((f) => f.key.endsWith("|overflow"));

    expect(overflows.length).toBeGreaterThan(0);
    for (const finding of overflows) {
      expect(typeof finding.magnitude, `${finding.key} has no magnitude`).toBe("number");
    }
  });

  it("fails every recorded overflow when the same page measures wider", () => {
    const baseline = committedBaseline("mobile-audit");
    const overflows = [...baseline.byKey.values()].filter((f) => f.key.endsWith("|overflow"));

    const worseRun = overflows.map((f) => ({ ...f, magnitude: (f.magnitude as number) + 1 }));
    const { fresh, worsened } = classifyAgainstBaseline(worseRun, baseline);

    expect(fresh).toEqual([]);
    expect(worsened.map((w) => w.key).sort()).toEqual(overflows.map((f) => f.key).sort());
  });
});

/**
 * Runs the real `finishAudit` in a child process against a throwaway baseline, so the assertion is
 * on the EXIT CODE the audits actually produce rather than on the classifier they call. A gate that
 * classifies a regression correctly and then does not act on it is not a gate.
 */
const runFinishAudit = (
  findings: unknown[],
  recorded: AuditFinding[],
  { update = false }: { update?: boolean } = {},
): { status: number; stderr: string; writtenKeys: string[] | null } => {
  const name = "probe-finish-audit";
  const path = join(process.cwd(), `scripts/testing/baselines/${name}.json`);
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "scripts/testing/lib-audit-baseline.mjs"),
  ).href;

  writeFileSync(
    path,
    JSON.stringify({
      audit: name,
      takenAt: "2026-08-22T00:00:00.000Z",
      note: "",
      findings: recorded,
    }),
  );

  try {
    const script = [
      `const m = await import(${JSON.stringify(moduleUrl)});`,
      `m.finishAudit({`,
      `  name: ${JSON.stringify(name)},`,
      `  measure: () => (${JSON.stringify(findings)}),`,
      `  unmeasurable: [],`,
      `  note: "probe",`,
      `});`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, UPDATE_BASELINE: update ? "1" : "0" },
    });
    // POST-STATE, read before teardown. What the child left in the baseline file is the only thing
    // that distinguishes a guard which refused from one that refused after writing.
    const writtenKeys = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")).findings as AuditFinding[]).map((f) => f.key)
      : null;
    return { status: result.status ?? -1, stderr: result.stderr, writtenKeys };
  } finally {
    // Teardown here rather than after the assertions: a failing expectation must not be able to
    // leave a stray baseline file behind for the next run to compare against.
    rmSync(path, { force: true });
  }
};

describe("finishAudit acts on what it classified", () => {
  it("exits non-zero when a baselined finding measured worse", () => {
    const result = runFinishAudit(
      [overflowFinding("a|overflow", 900)],
      [overflowFinding("a|overflow", 400)],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WORSE");
    expect(
      existsSync(join(process.cwd(), "scripts/testing/baselines/probe-finish-audit.json")),
    ).toBe(false);
  });

  it("exits zero when every baselined finding measured no worse", () => {
    const result = runFinishAudit(
      [overflowFinding("a|overflow", 400)],
      [overflowFinding("a|overflow", 400)],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("WORSE");
  });
});

/**
 * The declaration gate, measured by what reaches the baseline FILE rather than by what it prints.
 *
 * Its harmful move is positional: below the `UPDATE_BASELINE` branch, it still refuses, still exits
 * 5, and still prints the same UNDECLARED line — after the finding has been written into the
 * baseline, where the next run reads it as a known and permitted state. Only the post-state can
 * tell those two apart, so that is what these assert.
 */
describe("the declaration gate refuses before anything is written", () => {
  const UNDECLARED = { key: "x|overflow", class: "nonesuch", magnitude: 400 };

  it("exits 5 and leaves the baseline untouched when regenerating", () => {
    const result = runFinishAudit([UNDECLARED], [overflowFinding("a|overflow", 400)], {
      update: true,
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("UNDECLARED");
    expect(result.writtenKeys).toEqual(["a|overflow"]);
  });

  it("exits 5 for a finding whose class is declared but whose magnitude is not a number", () => {
    const result = runFinishAudit(
      [{ key: "x|overflow", class: "overflow", magnitude: null }],
      [overflowFinding("a|overflow", 400)],
      { update: true },
    );

    expect(result.status).toBe(5);
    expect(result.writtenKeys).toEqual(["a|overflow"]);
  });

  // Clause 3: the detector above must be shown to REACH the write it claims the gate got in front
  // of. Without this, a gate that refused for some unrelated reason would read identically.
  it("writes the baseline when every finding is declared", () => {
    const result = runFinishAudit(
      [overflowFinding("x|overflow", 400)],
      [overflowFinding("a|overflow", 400)],
      { update: true },
    );

    expect(result.status).toBe(0);
    expect(result.writtenKeys).toEqual(["x|overflow"]);
  });
});

/**
 * Regenerating is the one operation that DELETES a recorded finding, and the README hands out the
 * command with no warning beside it. These pin that it cannot delete a finding this machine was
 * never in a position to see.
 */
describe("writeBaseline against findings recorded on another machine", () => {
  const NAME = "probe-write-baseline";
  const PATH = join(process.cwd(), `scripts/testing/baselines/${NAME}.json`);
  const CURATED = { key: "ci-only|overflow", class: "overflow", seenIn: "ci", magnitude: 400 };

  const regenerate = (measured: AuditFinding[], drop: boolean): AuditFinding[] => {
    writeFileSync(
      PATH,
      JSON.stringify({ audit: NAME, takenAt: null, note: "", findings: [CURATED] }),
    );
    const previous = process.env[CURATED_DROP_FLAG];
    try {
      if (drop) process.env[CURATED_DROP_FLAG] = "1";
      else delete process.env[CURATED_DROP_FLAG];
      writeBaseline(NAME, measured, "regenerated");
      return [...readBaseline(NAME).byKey.values()];
    } finally {
      // Teardown before any assertion runs, and the environment restored whether or not the write
      // threw: a stray file in the real baselines directory would be compared against by the next
      // run, and a leaked flag would change what every later test in this file measures.
      if (previous === undefined) delete process.env[CURATED_DROP_FLAG];
      else process.env[CURATED_DROP_FLAG] = previous;
      rmSync(PATH, { force: true });
    }
  };

  it("carries a seenIn finding forward when this run could not reproduce it", () => {
    const written = regenerate([overflowFinding("local|overflow", 610)], false);

    expect(written.map((f) => f.key).sort()).toEqual(["ci-only|overflow", "local|overflow"]);
    expect(written.find((f) => f.key === "ci-only|overflow")?.magnitude).toBe(400);
    expect(existsSync(PATH)).toBe(false);
  });

  it("drops it only when told to explicitly", () => {
    const written = regenerate([overflowFinding("local|overflow", 610)], true);

    expect(written.map((f) => f.key)).toEqual(["local|overflow"]);
    expect(existsSync(PATH)).toBe(false);
  });

  it("does not duplicate a curated finding this run DID reproduce", () => {
    const written = regenerate([overflowFinding("ci-only|overflow", 401)], false);

    expect(written.map((f) => f.key)).toEqual(["ci-only|overflow"]);
    expect(written[0]?.magnitude).toBe(401);
  });
});
