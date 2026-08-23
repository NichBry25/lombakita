import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyAgainstBaseline,
  parseBaseline,
  type AuditFinding,
  type Baseline,
} from "./lib-audit-baseline.mjs";

const committedBaseline = (name: string): Baseline =>
  parseBaseline(
    JSON.parse(readFileSync(join(process.cwd(), `scripts/testing/baselines/${name}.json`), "utf8")),
  );

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
  findings: AuditFinding[],
  recorded: AuditFinding[],
): { status: number; stderr: string } => {
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
      env: { ...process.env, UPDATE_BASELINE: "0" },
    });
    return { status: result.status ?? -1, stderr: result.stderr };
  } finally {
    // Teardown here rather than after the assertions: a failing expectation must not be able to
    // leave a stray baseline file behind for the next run to compare against.
    rmSync(path, { force: true });
  }
};

describe("finishAudit acts on what it classified", () => {
  it("exits non-zero when a baselined finding measured worse", () => {
    const result = runFinishAudit(
      [{ key: "a|overflow", magnitude: 900 }],
      [{ key: "a|overflow", magnitude: 400 }],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WORSE");
    expect(
      existsSync(join(process.cwd(), "scripts/testing/baselines/probe-finish-audit.json")),
    ).toBe(false);
  });

  it("exits zero when every baselined finding measured no worse", () => {
    const result = runFinishAudit(
      [{ key: "a|overflow", magnitude: 400 }],
      [{ key: "a|overflow", magnitude: 400 }],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("WORSE");
  });
});
