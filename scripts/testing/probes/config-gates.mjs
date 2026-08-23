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
import { runProbes, substituteOnce } from "../guard-probe.mjs";

/** A line that names WHICH assertion failed, as opposed to any non-zero exit at all. */
const FAILURE_SIGNAL = /FAIL|✗|✘|error TS|AssertionError|Tests\s+\d+ failed/;

/**
 * Runs a command and reports whether it went red FOR AN IDENTIFIED REASON.
 *
 * Accepting any non-zero exit as "the guard refused" is Rule 36 clause 3's own failure mode wearing
 * the opposite sign: `vitest run some/renamed.test.ts` exits 1 having run nothing, and a probe
 * whose detector path is mistyped would report RED — PROVEN. So an exit with no recognisable
 * failure line THROWS: a detector that crashed did not measure, and must not be read either way.
 */
const fails = (command, args) => {
  const label = `${command} ${args.join(" ")}`;
  try {
    execFileSync(command, args, { stdio: "pipe" });
    return { refused: false, evidence: `${label} still passed` };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/No test files found/i.test(output)) {
      throw new Error(`${label} ran no tests at all — the detector never reached an assertion`);
    }
    const named = output.split("\n").find((line) => FAILURE_SIGNAL.test(line));
    if (!named) {
      throw new Error(
        `${label} exited ${error.status} without naming a failed assertion. A detector that ` +
          `crashed is not a guard that refused. Tail of its output:\n${output.slice(-600)}`,
      );
    }
    return { refused: true, evidence: `detector went red: ${named.trim().slice(0, 140)}` };
  }
};

const vitest = (file) => fails("npx", ["vitest", "run", file]);

const probes = [
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
    detect: async () => fails("npm", ["run", "verify:assertion-strength"]),
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
    appliedMarkers: ['if (appEnv === "no-such-environment")'],
    mutate: () =>
      substituteOnce(
        "src/config/env.server.ts",
        '  if (appEnv === "test") {\n    return false;\n  }',
        '  if (appEnv === "no-such-environment") {\n    return false;\n  }',
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
    name: "a candidate cannot presign an upload against another candidate's document request",
    // The guard is the WHERE clause: `loadRequestForCandidate` scopes by the caller's own
    // registration, so ownership and existence collapse into one 404. There is no move analogue —
    // `requireOpenRequestForCandidate` RETURNS the row `prepareRequestDocumentUpload` needs for the
    // object key, so moving it below its use is a reference error rather than a silent reordering.
    // Rule 36 names that shape as the one to prefer; this probe is therefore removal only.
    klass: "D",
    harmfulMove:
      "dropping the ownership predicate, so any candidate can presign against any request id",
    files: ["src/server/registration-documents/registration-document-service.ts"],
    appliedMarkers: ["// probe: ownership predicate removed"],
    mutate: () =>
      substituteOnce(
        "src/server/registration-documents/registration-document-service.ts",
        "        eq(competitionDocumentRequests.id, requestId),\n" +
          "        eq(competitionRegistrations.studentId, userId),",
        "        eq(competitionDocumentRequests.id, requestId),\n" +
          "        // probe: ownership predicate removed",
      ),
    detect: async () =>
      vitest("src/server/registration-documents/document-request-ownership-db.integration.test.ts"),
  },
];

await runProbes(probes);
