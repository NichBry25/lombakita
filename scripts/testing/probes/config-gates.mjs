/*
 * Rule 36 probes for the gates Step 7.7-PRE added or repaired that need no browser.
 *
 * Each one breaks the guard's premise in the file where it lives, then runs the detector and
 * requires it to go RED. A guard whose test still passes when the guard is gone is a guard nobody
 * has observed working; six of the twelve defects this step exists to fix were exactly that.
 *
 * Usage: node scripts/testing/probes/config-gates.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { TEST_FAILURE, refusedWhen, run } from "./detectors.mjs";

/**
 * Runs a command and reports whether it went red FOR AN IDENTIFIED REASON.
 *
 * `reached` is what makes this a Rule 36 clause 3 detector rather than an exit-code reader: the run
 * must name which assertion failed. Its absence throws, because a crashed detector is not a guard
 * that refused. The shape comes from browser-audit-refusals.mjs, which had it first.
 */
const fails = (command, args, reached = TEST_FAILURE) =>
  refusedWhen(run(command, args), { reached, label: `${command} ${args.join(" ")}` });

/**
 * The assertion-strength gate reports its verdict in prose rather than a runner's vocabulary, so it
 * needs its own signal. The leading digit class matters: the same sentence is printed with a count
 * of zero when the gate PASSES, and a detector that accepted it would be reading a success.
 */
const WEAK_ASSERTION = /[1-9]\d* cannot fail for the reason they name/;

const vitest = (file) => fails("npx", ["vitest", "run", file]);

export const probes = [
  {
    name: "database-backed suites are required by default",
    // The tripwire throws at module load. There is no position inside the module at which it would
    // NOT throw before a consumer ran, so a move analogue does not exist here; the removal test is
    // the whole test, and Rule 36 asks for that to be said rather than for a probe that measures
    // nothing.
    klass: "C",
    harmfulMove: "restoring opt-in, so a worktree without .env.local silently skips 285 tests",
    files: ["src/server/testing/database-url.ts"],
    appliedMarkers: ['process.env.REQUIRE_DB_TESTS === "1"'],
    mutate: () =>
      substituteOnce(
        "src/server/testing/database-url.ts",
        'export const databaseTestsRequired = process.env.REQUIRE_DB_TESTS !== "0";',
        'export const databaseTestsRequired = process.env.REQUIRE_DB_TESTS === "1";',
      ),
    detect: async () => vitest("src/server/testing/database-url.test.ts"),
  },
  {
    name: "the typecheck gate ignores the dev server's generated types",
    klass: "D",
    harmfulMove:
      "compiling a directory a long-running process rewrites, so a torn write fails the gate",
    files: ["tsconfig.json"],
    appliedMarkers: ['"docs/lombakita-ui-guide"\n  ]'],
    // The mutation REMOVES the exclusion, because that is the harmful move. `next build` puts the
    // `include` entry back on its own — it did exactly that mid-step, and the pinning test caught
    // it — so the exclusion is the only half a person controls.
    mutate: () =>
      substituteOnce(
        "tsconfig.json",
        '    "docs/lombakita-ui-guide",\n    ".next/dev"\n  ]',
        '    "docs/lombakita-ui-guide"\n  ]',
      ),
    compiles: () => JSON.parse(readFileSync("tsconfig.json", "utf8")),
    // The FUNCTIONAL detector, not the assertion about the config: a real torn file is written into
    // the directory under test and `npm run typecheck` is asked what it thinks. Teardown is in a
    // `finally` so the file cannot outlive the probe (Rule 35).
    detect: async () => {
      mkdirSync(".next/dev/types", { recursive: true });
      writeFileSync(".next/dev/types/torn-write-probe.ts", 'export const torn: number = "no";\n');
      try {
        return fails("npx", ["tsc", "--noEmit"]);
      } finally {
        rmSync(".next/dev/types/torn-write-probe.ts", { force: true });
      }
    },
  },
  {
    name: "the format gate runs in CI",
    klass: "C",
    harmfulMove: "removing the step, so the standard goes back to being advisory",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# format gate removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: Format\n        run: npm run format:check\n",
        "      # format gate removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "the mobile layout audit runs in CI",
    klass: "C",
    harmfulMove:
      "removing the step, so a 390px regression is again seen only by whoever runs it locally",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# mobile audit removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: Mobile layout audit\n        if: always()\n        run: node scripts/testing/mobile-audit.mjs\n",
        "      # mobile audit removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "the contrast audit runs in CI",
    klass: "C",
    harmfulMove:
      "removing the step, so the only check that can see a dark-on-dark theme stops running",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# contrast audit removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: Text contrast and tone separation audit\n        if: always()\n        run: node scripts/testing/contrast-audit.mjs\n",
        "      # contrast audit removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "the ui-state assertions run in CI",
    klass: "C",
    harmfulMove: "removing the step, so withheld affordances are again checked only by hand",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# ui-states removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: UI state assertions\n        run: node scripts/testing/ui-states.mjs\n",
        "      # ui-states removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "no api-matrix assertion may pass for a reason other than the one it names",
    klass: "D",
    harmfulMove:
      "reintroducing a status range, which accepts a payload rejection for a policy gate",
    files: ["scripts/testing/api-matrix.mjs"],
    appliedMarkers: ["publishWhileSuspended.status >= 400"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/api-matrix.mjs",
        'refusedWith(publishWhileSuspended, 403, "institution_suspended")',
        "publishWhileSuspended.status >= 400 && publishWhileSuspended.status < 500",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/api-matrix.mjs"]),
    detect: async () => fails("npm", ["run", "verify:assertion-strength"], WEAK_ASSERTION),
  },
  {
    name: "the assertion-strength gate runs in CI",
    klass: "C",
    harmfulMove: "removing the step, so the next range form is written unopposed",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# assertion strength removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: Assertion strength\n        run: npm run verify:assertion-strength\n",
        "      # assertion strength removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "an automated environment never delivers email",
    klass: "C",
    harmfulMove:
      "putting `test` back on the delivering side, so a seeded run mails every fixture address",
    files: ["src/config/env.server.ts"],
    appliedMarkers: ["// probe: test back on the delivering side"],
    // The mutation RESTORES the old rule — "anything that is not local delivers" — rather than
    // renaming the environment to one that does not exist. The rename does not typecheck, so under
    // a mandatory clause 1 it is a refusal rather than a probe, and under the optional clause it
    // was believed for a fortnight: `tsc` and `vitest` both go red on a type error exactly as they
    // do on a guard holding.
    mutate: () =>
      substituteOnce(
        "src/config/env.server.ts",
        '  if (appEnv === "test") {\n    return false;\n  }\n\n  if (appEnv !== "local") {',
        '  // probe: test back on the delivering side\n  if (appEnv !== "local") {',
      ),
    detect: async () => vitest("src/config/env-email-delivery.test.ts"),
  },
  {
    name: "the disabled exemption reaches a label wrapping its control — REMOVED",
    klass: "D",
    harmfulMove: "exempting by ancestry alone, which misses every checkbox row in the app",
    files: ["scripts/testing/lib-contrast.mjs"],
    appliedMarkers: ["if (el.closest(\":disabled, [aria-disabled='true']\")) continue;"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-contrast.mjs",
        "      if (isInactive(el)) continue;",
        "      if (el.closest(\":disabled, [aria-disabled='true']\")) continue;",
      ),
    detect: async () => fails("node", ["scripts/testing/contrast-audit-selftest.mjs"]),
  },
  {
    name: "the disabled exemption reaches a label wrapping its control — MOVED",
    klass: "D",
    // The move that matters: the exemption still runs, but AFTER the finding has been recorded.
    // Every text of every inactive component is then reported, which is the state that buries the
    // real findings — and a presence check on the guard's own line would not see it.
    harmfulMove: "running the exemption after the finding is recorded, so it exempts nothing",
    files: ["scripts/testing/lib-contrast.mjs"],
    appliedMarkers: ["// probe: exemption moved below the record"],
    mutate: () => {
      substituteOnce(
        "scripts/testing/lib-contrast.mjs",
        "      if (isInactive(el)) continue;",
        "      // probe: exemption moved below the record",
      );
      // After the `findings.set`, where a `continue` at the end of the loop body changes nothing
      // and the exempt element has already been reported.
      substituteOnce(
        "scripts/testing/lib-contrast.mjs",
        "          sample: text.slice(0, 40),\n        });\n      }\n    }",
        "          sample: text.slice(0, 40),\n        });\n      }\n      if (isInactive(el)) continue;\n    }",
      );
    },
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-contrast.mjs"]),
    detect: async () => fails("node", ["scripts/testing/contrast-audit-selftest.mjs"]),
  },
  {
    name: "a baselined finding that measured worse fails the run",
    // `classifyAgainstBaseline` is a pure function over two collections and `finishAudit` acts on
    // its result with a single exit. There is no write to order the check against, so a move
    // analogue does not exist for either; Rule 36 asks for that to be said rather than for a probe
    // that measures nothing. Both removal probes below are the whole test.
    klass: "D",
    harmfulMove:
      "comparing baselined findings by key alone, so a page baselined at 400px stays baselined at 900px",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: magnitude regressions no longer recorded"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "    worsened.push({ key: finding.key, was: recorded.magnitude, now: finding.magnitude });",
        "    // probe: magnitude regressions no longer recorded",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "the run's exit code acts on the regression it classified",
    klass: "D",
    harmfulMove:
      "classifying the regression, printing it, and still exiting 0 — the report is right and the gate is green",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["if (fresh.length > 0) {\n    process.exit(EXIT_FINDINGS);"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  if (fresh.length > 0 || worsened.length > 0) {\n    process.exit(EXIT_FINDINGS);",
        "  if (fresh.length > 0) {\n    process.exit(EXIT_FINDINGS);",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "an audit cannot emit a finding class this repository has not declared",
    // `finding-classes.mjs` is a declaration and the test beside it is what makes it one. Without
    // the test the file is documentation: an audit could emit anything, and the class would exist
    // only in the argument nobody compared to the table.
    klass: "D",
    harmfulMove:
      "emitting a class absent from the table, so nothing knows how bad that finding is or when it worsens",
    files: ["scripts/testing/mobile-audit.mjs"],
    appliedMarkers: ['"wide-by-probe"'],
    mutate: () =>
      substituteOnce(
        "scripts/testing/mobile-audit.mjs",
        '        finding(\n          "wide",\n          `${page.id}|wide|${w.descriptor}`,',
        '        finding(\n          "wide-by-probe",\n          `${page.id}|wide|${w.descriptor}`,',
      ),
    detect: async () => vitest("scripts/testing/finding-classes.test.ts"),
  },
  {
    name: "the declaration gate refuses BEFORE the baseline is written",
    // The one probe in this file whose detector must be a post-state. Moved below the
    // `UPDATE_BASELINE` branch the gate still exits 5 and still prints UNDECLARED — after writing
    // the undeclared finding into the baseline, where the next run reads it as permitted. Every
    // output a detector could read is identical across the move; only the FILE differs.
    klass: "B",
    harmfulMove:
      "checking after the regeneration branch, so the finding it refuses is already in the baseline",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: declaration gate moved below the write"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  const findings = measure();\n  assertEveryFindingIsDeclared(findings);\n\n  if (updatingBaseline) {\n    writeBaseline(name, findings, note);\n    return;\n  }",
        "  const findings = measure();\n  // probe: declaration gate moved below the write\n\n  if (updatingBaseline) {\n    writeBaseline(name, findings, note);\n    return;\n  }\n  assertEveryFindingIsDeclared(findings);",
      ),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "regenerating a baseline cannot silently drop what this machine could not see",
    // A move analogue does not exist: `carried` is computed from the previous file and consumed by
    // the object being written, so moving the read below the write is a reference error rather than
    // a defect. The removal is the whole test, and Rule 36 asks for that to be said.
    klass: "B",
    harmfulMove:
      "writing only what this run measured, which DELETES the CI-only findings rather than superseding them",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: curated findings no longer carried"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  [...previous.byKey.values()].filter((f) => f.seenIn && !measuredKeys.has(f.key));",
        "  // probe: curated findings no longer carried\n  [];",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "the assertion-strength gate reads every harness that has assertions",
    klass: "D",
    harmfulMove:
      "narrowing the declared subject back to one file, which is how twenty-two assertions went unread",
    files: ["scripts/testing/assertion-harnesses.ts"],
    appliedMarkers: ['"scripts/testing/api-matrix.mjs",\n] as const;'],
    mutate: () =>
      substituteOnce(
        "scripts/testing/assertion-harnesses.ts",
        '  "scripts/testing/api-matrix.mjs",\n  "scripts/testing/r2-flows.mjs",\n] as const;',
        '  "scripts/testing/api-matrix.mjs",\n] as const;',
      ),
    detect: async () => vitest("scripts/testing/assertion-harnesses.test.ts"),
  },
  {
    name: "a weak assertion is seen through the helper it was written behind",
    // The gate read the call site's own text, so `refusedWith(r, 403, "x")` was strong by virtue of
    // being a call. Every weakness in this repository was one helper deep, which is where a
    // weakness naturally goes: it is written once and reused. Weakening the HELPER and requiring
    // the gate to notice is the only thing that shows the resolution happens.
    klass: "D",
    harmfulMove:
      "putting the status range inside the shared helper, where a call-site scan cannot see it",
    files: ["scripts/testing/lib-assertions.mjs"],
    appliedMarkers: ["r.status >= 400 && r.status < 500"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-assertions.mjs",
        "export const refusedWith = (r, status, code) => r.status === status && errorCode(r) === code;",
        "export const refusedWith = (r, status, code) => r.status >= 400 && r.status < 500;",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-assertions.mjs"]),
    detect: async () => fails("npm", ["run", "verify:assertion-strength"], WEAK_ASSERTION),
  },
  {
    name: "the format gate's exclusions are the declared ones and no others",
    klass: "D",
    harmfulMove:
      "adding a path back to the gate that no clean checkout contains, which makes it permanently red",
    files: ["package.json"],
    appliedMarkers: ["--write README.md", "--check README.md"],
    // README.md specifically, because it is one of the declared exclusions and the reason it is
    // excluded is the one that matters: it is gitignored, so it is on this disk and on no runner's.
    // Adding it to both scripts keeps them identical, so the only test that can go red is the one
    // asserting the exclusion — which is the claim being probed.
    mutate: () => {
      substituteOnce(
        "package.json",
        '"format": "prettier --ignore-unknown --write \\"src/**',
        '"format": "prettier --ignore-unknown --write README.md \\"src/**',
      );
      substituteOnce(
        "package.json",
        '"format:check": "prettier --ignore-unknown --check \\"src/**',
        '"format:check": "prettier --ignore-unknown --check README.md \\"src/**',
      );
    },
    detect: async () => vitest("scripts/testing/format-gate-scope.test.ts"),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe
// set — which files each one mutates, and whether it declares its own compile check — without
// mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
