/*
 * The gate that fails a run in which a required test was collected and did not run, tested by running
 * vitest against fixtures and reading the exit code.
 *
 * WHY A SUBPROCESS. The subject is not a function; it is what the runner does with a suite — a whole
 * run's exit code. `onTestRunEnd` is only reachable by a real run, and the filter arm is only
 * reachable by a real `-t`, because the pattern reaches the reporter out of the resolved config.
 * Calling the reporter in-process would hand it a `testModules` array this file built itself
 * (Rule 33) and would never exercise the plugin that installs it at all.
 *
 * The fixtures are `.fixture.ts` under `scripts/testing/fixtures/required-db-reporter/`, which the
 * root `include` does not match, so `npm run test` never collects one. They run under the fixture
 * config, which spreads the root config — so the gate under test is the gate the app runs.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The runner's own working directory, which is what the reporter reads its subject against
// (`relative(process.cwd(), testModule.moduleId)`) and what a `--config` path is resolved from.
const REPO_ROOT = process.cwd();

const VITEST_BIN = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const FIXTURE_CONFIG = "scripts/testing/fixtures/required-db-reporter/vitest.config.ts";

type FixtureRunOptions = {
  /** The fixture to collect, as a substring of its path. */
  fixture: string;
  /**
   * Handed to `-t`: the string vitest matches the pattern against — the space-joined chain of
   * enclosing suite names and the test's own name, with the file left out of it.
   */
  testNamePattern?: string;
  /** Handed to `--reporter`: the flag that used to remove the gate (LAUNCH-D156). */
  reporter?: string;
};

type FixtureRun = {
  exitCode: number | null;
  failedToStart: string | undefined;
  stdout: string;
  stderr: string;
};

const runFixture = ({ fixture, testNamePattern, reporter }: FixtureRunOptions): FixtureRun => {
  const args = [
    VITEST_BIN,
    "run",
    "--root",
    REPO_ROOT,
    "--config",
    FIXTURE_CONFIG,
    fixture,
    ...(reporter ? [`--reporter=${reporter}`] : []),
    ...(testNamePattern ? ["-t", testNamePattern] : []),
  ];

  // `REQUIRE_DB_TESTS=0` is the gate's own opt-out and the harness that runs this suite sets it. The
  // fixture has to be in the state CI is in — the default — or the cases expecting a failure would be
  // measuring the opt-out instead of the gate. Deleting the variable restores the documented default;
  // it does not set a value the gate does not have.
  const env = { ...process.env };
  delete env.REQUIRE_DB_TESTS;

  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });

  return {
    exitCode: result.status,
    failedToStart: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

/** Why the run exited the way it did, carried in the assertion's message rather than found later. */
const describeRun = (run: FixtureRun): string =>
  run.failedToStart
    ? `vitest did not start: ${run.failedToStart}`
    : `exit ${run.exitCode}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`;

describe("the skipped-test gate", () => {
  it("fails a run in which a required test was skipped", () => {
    const run = runFixture({ fixture: "skipped.fixture.ts" });
    expect(run.exitCode, describeRun(run)).toBe(1);
  });

  it("still fails that run when the CLI names its own reporter", () => {
    const run = runFixture({ fixture: "skipped.fixture.ts", reporter: "dot" });
    expect(run.exitCode, describeRun(run)).toBe(1);
  });

  it("passes a run in which nothing was skipped", () => {
    const run = runFixture({ fixture: "clean.fixture.ts" });
    expect(run.exitCode, describeRun(run)).toBe(0);
  });

  it("fails a filtered run in which the pattern matched a test that did not run", () => {
    // `-t` marks every test it excludes `skip` — the same mode `it.skip` produces — so "the filter
    // excluded this" and "something silenced a test the filter selected" are the same observation
    // until the pattern is asked which of the two it did.
    const run = runFixture({
      fixture: "filtered.fixture.ts",
      testNamePattern: "under the pattern",
    });
    expect(run.exitCode, describeRun(run)).toBe(1);
  });

  it("passes a filtered run in which the pattern excused every inert test", () => {
    const run = runFixture({
      fixture: "filtered.fixture.ts",
      testNamePattern: "runs under the pattern",
    });
    expect(run.exitCode, describeRun(run)).toBe(0);
  });

  it("fails a filtered run in which the pattern matched no test at all", () => {
    // Every inert test is one the pattern excluded, so the excusing arm above has nothing left to
    // count and this run is evidence about nothing. Vitest cannot supply this on its own: a `-t`
    // that matches nothing is a green run in which every test was skipped.
    const run = runFixture({
      fixture: "clean.fixture.ts",
      testNamePattern: "no test in this fixture is named this",
    });
    expect(run.exitCode, describeRun(run)).toBe(1);
    expect(run.stderr, describeRun(run)).toMatch(/NO TEST RAN/);
  });
});
