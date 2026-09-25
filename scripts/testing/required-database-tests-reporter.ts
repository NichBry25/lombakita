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
// `databaseTestsRequired` (the default; `REQUIRE_DB_TESTS=0` is the deliberate opt-out), any test that
// does not run fails the run it is in.
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
// It reads the predicate from its own module, not from `@/server/testing/database-url`: that module
// throws at load when a database is required and absent, and this runs before any test is collected,
// so the throw would replace every suite's own failure with one reporter-load error.

import { relative } from "node:path";
import type { Reporter, TestModule, TestRunEndReason } from "vitest/node";
import { databaseTestsRequired } from "@/server/testing/database-tests-required";

/** A test that was collected and then not run, named so the reader can go and look at it. */
type InertTest = { file: string; test: string; mode: "skip" | "todo" | "skipped" };

/** The modes collection can hand a test that mean it will never execute. */
const NOT_RUN = new Set(["skip", "todo"]);

export default class RequiredDatabaseTestsReporter implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    // An interrupted run is not evidence about the tests that never got their turn, and it already
    // exits non-zero. Opting out of the database opts out of this rule with it, which is the same
    // switch that decides whether the database-backed suites skip.
    if (reason === "interrupted" || !databaseTestsRequired) return;

    const inert: InertTest[] = [];

    for (const testModule of testModules) {
      const file = relative(process.cwd(), testModule.moduleId);

      for (const test of testModule.children.allTests()) {
        const mode = test.options.mode;
        if (NOT_RUN.has(mode)) {
          inert.push({ file, test: test.fullName, mode: mode as "skip" | "todo" });
        } else if (test.result().state === "skipped") {
          // `ctx.skip()` at run time leaves the mode at "run", so the two checks are not the same one.
          inert.push({ file, test: test.fullName, mode: "skipped" });
        }
      }
    }

    if (inert.length === 0) return;

    console.error("");
    console.error(`FAIL  ${inert.length} test(s) did not run.`);

    for (const { file, test, mode } of inert) {
      console.error(`  ${mode}: ${file} > ${test}`);
    }

    console.error(
      `REQUIRE_DB_TESTS is not "0", so no test may be skipped: a suite whose every test was skipped ` +
        `reports the same green tick as a suite that passed. Set REQUIRE_DB_TESTS=0 only to run the ` +
        `rest of the suite deliberately without them.`,
    );

    process.exitCode = 1;
  }
}
