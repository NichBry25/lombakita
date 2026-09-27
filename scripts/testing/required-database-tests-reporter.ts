// A VITEST REPORTER THAT FAILS A RUN IN WHICH A TEST WAS COLLECTED AND DID NOT RUN.
//
// THE FAILURE THIS EXISTS TO CLOSE (LAUNCH-D156). A suite whose every test is skipped reports exactly
// what a suite that passed reports: a green tick, exit 0, and a lower total that nothing compares
// against anything. C2.2's own readiness-agreement suite did it — module init order against a hoisted
// `vi.mock` closure left it with ten skipped tests and a green run. Rule 36 evidence was then produced
// in a configuration CI does not use, because "run it the way CI does" was an instruction to the
// operator and not a property of the tooling.
//
// So the rule is mechanical and lives in the runner rather than in a sentence: when
// `databaseTestsRequired` (the default; `REQUIRE_DB_TESTS=0` is the deliberate opt-out, and what it
// permits is a SKIPPED test — not a run without one), any test that does not run fails the run it is
// in.
//
// AND THE REST OF THE DEBT'S SUBJECT, so this file's coverage is not guessed at (Rule 38). The debt is
// titled "a skipped DB suite reads as a pass" and names two shapes. The second — a file that collects
// NO test — is not this reporter's job, because vitest 3.2.4 already fails it at the file level, before
// any reporter is consulted: `Error: No test suite found in file <path>` when the module registers
// nothing, and `Error: No test found in suite <name>` when a `describe` runs and adds no test. Both
// were measured, not assumed; both leave the module `ok() === false`. An arm here could never fire,
// and an arm that cannot fire is a claim of coverage the instrument does not have.
//
// WHY A REPORTER AND NOT A SEPARATE COMMAND. `onTestRunEnd` sees every module's collected tests and
// each one's mode and result — the facts the rule is stated over, available nowhere else without
// parsing a machine-readable report back out of a second process. It also means the rule holds for
// `npm run test` itself, so `/precheck`, CI, and a developer's own run are the same gate.
//
// A TEST-NAME FILTER IS NOT THE THING THIS RULE IS ABOUT, AND THE TWO ARE INDISTINGUISHABLE BY MODE.
// `vitest run <file> -t <name>` marks every test the pattern excludes `skip` (the worker's
// `interpretTaskModes`), which is the same mode a literal `it.skip` produces. A rule that failed a
// run for every `skip` therefore failed every filtered run — and the detectors in
// `scripts/testing/probes/` are built on `-t`, so the probes' own controls refused. The filter is
// READ from the resolved config (`Vitest#config.testNamePattern`, public on `ResolvedConfig`),
// never inferred from the skip count, because a count cannot tell a deliberate exclusion from a
// silenced test.
//
// SO THE FILTER EXCUSES AN INERT TEST ONLY WHERE IT IS THE FILTER THAT EXCLUDED IT. Each inert test
// is asked whether the pattern matched it, and only the ones it did not are dropped. That arm is not
// decoration: `-t` and `it.skip` leave a test in the same mode, so without it, "the filter silenced
// this test" and "the filter selected this test and something silenced it anyway" are the same
// observation — which is the whole failure this file exists to close, one flag further in. Nothing
// executed at all under a filter is still a failure of its own: the run is then evidence about
// nothing.
//
// It reads the predicate from its own module, not from `@/server/testing/database-url`: that module
// throws at load when a database is required and absent, and this runs before any test is collected,
// so the throw would replace every suite's own failure with one reporter-load error.

import { relative } from "node:path";
import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  TestSuite,
  Vitest,
} from "vitest/node";
import { databaseTestsRequired } from "@/server/testing/database-tests-required";

/**
 * A test that was collected and then not run, named so the reader can go and look at it.
 *
 * `underFilter` is the string the test-name pattern was matched against, rebuilt from the node API so
 * the filter can be asked which inert tests it is actually responsible for.
 */
type InertTest = {
  file: string;
  test: string;
  underFilter: string;
  mode: "skip" | "todo" | "skipped";
};

/**
 * The string vitest matches `-t` against, rebuilt from the node API.
 *
 * The pattern is matched against the runner's own task name (`@vitest/runner/dist/chunk-hooks.js`:
 * `if (namePattern && !getTaskFullName(t).match(namePattern)) {`), and that name is the space-joined
 * chain of enclosing suite names and the test's own name — `getTaskFullName` is
 * `` `${task.suite ? `${getTaskFullName(task.suite)} ` : ""}${task.name}` ``. THE FILE IS NOT IN THE
 * CHAIN: the file-level collector's `.suite` is deleted when it is built, so the walk stops at the
 * first `describe`. Measured, not read: `-t` naming the file selects nothing.
 *
 * `TestCase#parent` and `TestSuite#parent` are built from that same `task.suite` chain with the
 * module as the fallback, so walking the parents until the module rebuilds exactly the string the
 * pattern was matched against. Neither public shortcut is that string: `Test#fullName` joins with
 * `" > "`, and `moduleId` is an absolute path.
 */
function testNameMatchedByFilter(test: TestCase): string {
  const names: string[] = [];

  for (
    let node: TestCase | TestSuite | TestModule = test;
    node.type !== "module";
    node = node.parent
  ) {
    names.unshift(node.name);
  }

  return names.join(" ");
}

/** The modes collection can hand a test that mean it will never execute. */
const NOT_RUN = new Set(["skip", "todo"]);

/** The states a test reaches by executing. Anything else was collected and did not run. */
const RAN = new Set(["passed", "failed"]);

export default class RequiredDatabaseTestsReporter implements Reporter {
  /** The run itself, handed over by `onInit`, which is the only place the filter can be read from. */
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    // An interrupted run is not evidence about the tests that never got their turn, and it already
    // exits non-zero. Opting out of the database opts out of this rule with it: `REQUIRE_DB_TESTS=0`
    // PERMITS a database-backed suite to skip, and a run that permits skips is not one this rule can
    // hold. It does not itself skip anything — a suite skips only when the switch is off AND no
    // DATABASE_URL resolves, and it runs unchanged whenever one does, from the environment or from
    // `.env.local`.
    if (reason === "interrupted" || !databaseTestsRequired) return;

    const inert: InertTest[] = [];
    let ran = 0;

    for (const testModule of testModules) {
      const file = relative(process.cwd(), testModule.moduleId);

      for (const test of testModule.children.allTests()) {
        const mode = test.options.mode;
        const state = test.result().state;
        const named = { file, test: test.fullName, underFilter: testNameMatchedByFilter(test) };
        if (NOT_RUN.has(mode)) {
          inert.push({ ...named, mode: mode as "skip" | "todo" });
        } else if (state === "skipped") {
          // `ctx.skip()` at run time leaves the mode at "run", so the two checks are not the same one.
          inert.push({ ...named, mode: "skipped" });
        } else if (RAN.has(state)) {
          ran += 1;
        }
      }
    }

    const filter = this.vitest?.config.testNamePattern;

    // THE FILTER IS ASKED WHICH INERT TESTS IT EXCLUDED, and only those are excused. `-t P` marks
    // `skip` exactly the tests whose name does not match P, so an inert test the pattern DID match
    // was silenced by something else, and `-t` cannot explain it.
    const unexcused = filter
      ? inert.filter((entry) => entry.underFilter.match(filter) !== null)
      : inert;

    if (filter) {
      console.error("");
      console.error(`FILTERED  Test name pattern: ${filter}`);
      console.error(
        `  ${inert.length - unexcused.length} of ${inert.length} inert test(s) were excluded by the ` +
          `pattern and are not counted against this run.`,
      );
    }

    if (unexcused.length === 0) {
      if (!filter || ran > 0) return;

      console.error(
        `NO TEST RAN  the filter matched nothing: ${inert.length} test(s) were collected and none ` +
          `executed, so this run is evidence about nothing.`,
      );
      process.exitCode = 1;
      return;
    }

    console.error("");
    console.error(`FAIL  ${unexcused.length} test(s) did not run.`);

    for (const { file, test, mode } of unexcused) {
      console.error(`  ${mode}: ${file} > ${test}`);
    }

    console.error(
      `REQUIRE_DB_TESTS is not "0", so no test may be skipped: a suite whose every test was skipped ` +
        `reports the same green tick as a suite that passed.`,
    );

    process.exitCode = 1;
  }
}
