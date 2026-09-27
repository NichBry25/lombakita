import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/** The D156 gate's module, named once so the plugin below and `reporters` cannot drift apart. */
const REQUIRED_DATABASE_TESTS_REPORTER = "./scripts/testing/required-database-tests-reporter.ts";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    {
      // LAUNCH-D156. A CLI `--reporter` REPLACES `test.reporters` rather than adding to it, so a run
      // that named its own reporter — which is how the probes in `scripts/testing/probes/` read a
      // run — had the gate removed and reported a fully skipped suite as a pass. That is the exact
      // failure the gate exists to catch, switched off by the flag that changes the printing.
      //
      // `configureVitest` is vitest's own extension point on a Vite plugin, declared by vitest in
      // `vitest/dist/chunks/vite.d.CMLlLIFP.d.ts` as an augmentation of Vite's `Plugin` interface.
      // It runs after the CLI options have been merged into the resolved config and before the
      // reporters are created from `vitest.config.reporters` (`cli-api.BkDphVBG.js`: the hooks run
      // at `_setServer`, then `createReporters(resolved.reporters, this)`), so appending here is
      // the one position a `--reporter` cannot reach.
      name: "required-database-tests-reporter",
      configureVitest({ vitest }) {
        vitest.config.reporters.push([REQUIRED_DATABASE_TESTS_REPORTER, {}]);
      },
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // `scripts/` is included so the operator scripts' pure helpers are testable at all. Only
    // side-effect-free modules there may be imported from a test: `live-harness.ts` reads
    // `.env.local` and throws on a missing DATABASE_URL at import time, so a test reaching through
    // it would depend on an environment the assertion under test does not need.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Raised from the 5s default. Several auth suites import the auth.config module graph from
    // inside the test body, so the first test in each of those files pays a cold Vite transform of
    // next-auth + the Drizzle adapter + the server auth modules. That import is ~5s on a loaded
    // machine and ~30ms once cached, which made exactly the first test of each file fail on a busy
    // runner while every later test in the same file passed. This changes only how long a test may
    // take before being declared failed — fast tests stay fast.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // DB-BACKED FILES MUST NOT RUN AT THE SAME TIME AS EACH OTHER. `TEST_DATABASE_URL` resolves to
    // `DATABASE_URL`, so every database-backed file executes against one database, and one of them
    // takes ACCESS EXCLUSIVE on `finance_payment_instruction_snapshots` under a 5s `lock_timeout` to
    // prove what the code does when that table is gone. Run concurrently, a second file's ordinary
    // read of the same table blocks the lock, the probe fails 55P03, and the failure is reported
    // against an assertion that is fine.
    //
    // Chosen over a separate probe database, which the debt named as the other durable fix. A second
    // database is a provisioning step — created, migrated, kept at the same schema version — and a
    // worktree where someone skipped it silently falls back to the shared one, which is the failure
    // mode this whole step exists to remove. This is one line, cannot be half-applied, and holds in
    // every worktree and every CI job without anyone remembering anything.
    //
    // It does NOT stop the RUNNING APP touching that table while the suite holds the lock. That
    // contention is real and remains; the probe names 55P03 explicitly when it happens, so the
    // reader is told it is the harness rather than the assertion.
    //
    // Measured cost, 250 files / 2800 tests: 91s parallel, 161s serial. Both runs green.
    fileParallelism: false,
    // LAUNCH-D156. `default` prints the run; the gate that fails it when a test was collected and
    // did not run — otherwise indistinguishable from a pass — is installed by the plugin above
    // rather than named here, so that `--reporter` cannot replace it. See the reporter.
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
