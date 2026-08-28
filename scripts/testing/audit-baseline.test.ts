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
    const baseline = baselineOf([overflowFinding("a|overflow", 400)]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [overflowFinding("b|overflow", 400)],
      baseline,
    );

    expect(fresh.map((f) => f.key)).toEqual(["b|overflow"]);
    expect(worsened).toEqual([]);
  });

  it("accepts a baselined finding measured at exactly what was recorded", () => {
    const baseline = baselineOf([overflowFinding("a|overflow", 400)]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [overflowFinding("a|overflow", 400)],
      baseline,
    );

    expect(fresh).toEqual([]);
    expect(worsened).toEqual([]);
  });

  // The defect this exists to close: the key alone said "this page overflows", so a page baselined
  // at 400px stayed baselined at 900px and the gate reported green over the regression.
  it("fails a baselined finding that measured worse than it was recorded at", () => {
    const baseline = baselineOf([overflowFinding("a|overflow", 400)]);

    const { fresh, worsened } = classifyAgainstBaseline(
      [overflowFinding("a|overflow", 900)],
      baseline,
    );

    expect(fresh).toEqual([]);
    expect(worsened).toEqual([{ key: "a|overflow", was: 400, now: 900 }]);
  });

  it("does not fail a baselined finding that improved", () => {
    const baseline = baselineOf([overflowFinding("a|overflow", 400)]);

    const { worsened } = classifyAgainstBaseline([overflowFinding("a|overflow", 391)], baseline);

    expect(worsened).toEqual([]);
  });

  // THE FAIL-OPEN, INVERTED. This test used to assert the skip and justify it: findings whose kind
  // carries no measurable magnitude were "still compared by key alone, so adding magnitudes to one
  // audit cannot break the others". The premise was already false when it was written — `wide` and
  // `contrast` both carry magnitudes — and what it actually pinned was a recorded entry being held
  // to its key while it worsened without limit. Twelve entries were living in that state.
  it("refuses a recorded entry with no magnitude rather than comparing it by key", () => {
    const baseline = baselineOf([{ key: "a|wide|div.card", class: "wide" } as AuditFinding]);

    const { worsened, unclassifiable } = classifyAgainstBaseline(
      [{ key: "a|wide|div.card", class: "wide", magnitude: 9000 }],
      baseline,
    );

    expect(worsened).toEqual([]);
    expect(unclassifiable.map((f) => f.key)).toEqual(["a|wide|div.card"]);
  });

  it("refuses a recorded entry whose class this repository does not declare", () => {
    const baseline = baselineOf([
      { key: "a|overflow", class: "nonesuch", magnitude: 400 } as AuditFinding,
    ]);

    const { unclassifiable } = classifyAgainstBaseline(
      [overflowFinding("a|overflow", 400)],
      baseline,
    );

    expect(unclassifiable.map((f) => f.key)).toEqual(["a|overflow"]);
  });

  // A recorded entry this run did not reproduce still mutes the key it holds, so it is refused on
  // the same terms. Reading it as healed would report good news about an entry nothing can compare.
  it("refuses an unclassifiable entry even when this run did not reproduce it", () => {
    const baseline = baselineOf([{ key: "gone|overflow" } as AuditFinding]);

    const { healed, unclassifiable } = classifyAgainstBaseline([], baseline);

    expect(healed).toEqual(["gone|overflow"]);
    expect(unclassifiable.map((f) => f.key)).toEqual(["gone|overflow"]);
  });

  it("reports a recorded key that did not reproduce as healed", () => {
    const baseline = baselineOf([
      overflowFinding("a|overflow", 400),
      overflowFinding("b|overflow", 400),
    ]);

    const { healed } = classifyAgainstBaseline([overflowFinding("a|overflow", 400)], baseline);

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
  { update = false, drop = false }: { update?: boolean; drop?: boolean } = {},
): { status: number; stdout: string; stderr: string; writtenKeys: string[] | null } => {
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
      env: {
        ...process.env,
        UPDATE_BASELINE: update ? "1" : "0",
        [CURATED_DROP_FLAG]: drop ? "1" : "0",
      },
    });
    // POST-STATE, read before teardown. What the child left in the baseline file is the only thing
    // that distinguishes a guard which refused from one that refused after writing.
    const writtenKeys = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")).findings as AuditFinding[]).map((f) => f.key)
      : null;
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      writtenKeys,
    };
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
 * The refusal that closes the fail-open, measured on the EXIT CODE and on the FILE rather than on
 * the classifier that reports it. A comparison that identifies an uncomparable entry and then
 * carries on printing "none worse than recorded" is a report, not a gate.
 */
describe("finishAudit refuses a baseline it cannot compare", () => {
  it("exits 5 rather than reporting a run against an uncomparable entry", () => {
    const result = runFinishAudit(
      [overflowFinding("a|overflow", 400)],
      [{ key: "a|overflow", class: "overflow" } as AuditFinding],
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("UNCLASSIFIABLE");
  });

  // Clause 3: the refusal has to be shown to happen INSTEAD of the report, not alongside it. The
  // sentence below is the one a green run prints, and it is the one that must not appear.
  it("does not print a verdict about a baseline it just refused", () => {
    const result = runFinishAudit(
      [overflowFinding("a|overflow", 400)],
      [{ key: "a|overflow", class: "overflow" } as AuditFinding],
    );

    expect(result.stdout).not.toContain("none worse than recorded");
  });

  it("still compares a baseline whose every entry carries its class and magnitude", () => {
    const result = runFinishAudit(
      [overflowFinding("a|overflow", 400)],
      [overflowFinding("a|overflow", 400)],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("none worse than recorded");
  });
});

/**
 * The carry-over half, measured by POST-STATE. A carried entry never passes the emit gate: it is
 * copied out of the previous file into the new one, so an entry nothing can compare survives every
 * regeneration and can never acquire a magnitude. Six were living in exactly that loop.
 */
describe("writeBaseline refuses to carry an entry nothing can compare", () => {
  const UNCOMPARABLE = { key: "ci-only|wide|div.card", class: "wide", seenIn: "ci" };

  it("exits 5 and leaves the previous baseline in place", () => {
    const result = runFinishAudit(
      [overflowFinding("local|overflow", 610)],
      [UNCOMPARABLE as AuditFinding],
      { update: true },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("UNCARRIABLE");
    expect(result.writtenKeys).toEqual(["ci-only|wide|div.card"]);
  });

  it("carries it when it has the magnitude the recording machine measured", () => {
    const result = runFinishAudit(
      [overflowFinding("local|overflow", 610)],
      [{ ...UNCOMPARABLE, magnitude: 10 } as AuditFinding],
      { update: true },
    );

    expect(result.status).toBe(0);
    expect(result.writtenKeys?.sort()).toEqual(["ci-only|wide|div.card", "local|overflow"]);
  });

  // The documented escape stays open, because dropping DELETES the entry rather than keeping it in
  // a state nothing can compare. Refusing here as well would leave no way out of the loop.
  it("lets the explicit drop remove it instead", () => {
    const result = runFinishAudit(
      [overflowFinding("local|overflow", 610)],
      [UNCOMPARABLE as AuditFinding],
      { update: true, drop: true },
    );

    expect(result.status).toBe(0);
    expect(result.writtenKeys).toEqual(["local|overflow"]);
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
