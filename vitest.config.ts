import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
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
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
