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
import { fails, run } from "./detectors.mjs";

/**
 * The assertion-strength gate reports its verdict in prose rather than a runner's vocabulary, so it
 * needs its own signal. The leading digit class matters: the same sentence is printed with a count
 * of zero when the gate PASSES, and a detector that accepted it would be reading a success.
 */
const WEAK_ASSERTION = /[1-9]\d* cannot fail for the reason they name/;

// A process configured the way the Railway worker is: delivery ON, so nothing here is protected by
// an environment that happens not to send. Every credential is an obvious fake and the child
// answers its own HTTP, so no request reaches a real provider even with the guard removed.
const WORKER_LIKE_ENV = {
  DATABASE_URL: "postgresql://localhost:5432/lombakita",
  APP_ENV: "production",
  NEXT_PUBLIC_APP_ENV: "production",
  RUNTIME_NAME: "worker",
  AUTH_SECRET: "probe-only-secret-not-used-for-signing-anything-real",
  APP_BASE_URL: "https://probe.invalid",
  AUTH_URL: "https://probe.invalid",
  RESEND_API_KEY: "re_probe_key_not_real_0000000000",
  AUTH_EMAIL_FROM: "probe@probe.invalid",
};

/**
 * Whether a send to a reserved address actually reached the provider, run in a worker-like process.
 *
 * THE POST-STATE, not the error. Guarded and unguarded both end in a thrown something, so the only
 * honest question is whether a request to api.resend.com exists. The child records its own outbound
 * calls and prints them as JSON.
 */
const sentToProviderInWorker = async () => {
  const result = run(
    "npx",
    ["tsx", "scripts/testing/probes/worker-send-attempt.ts"],
    WORKER_LIKE_ENV,
  );
  const reported = /\{"refusal":.*\}/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);

  if (!reported) {
    throw new Error(
      "worker-send-attempt printed no verdict, so nothing was measured. Tail of its output:\n" +
        `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-600),
    );
  }

  const { refusal, attempts } = JSON.parse(reported[0]);

  return {
    refused: attempts.length > 0,
    evidence:
      attempts.length > 0
        ? `the worker sent to ${attempts.join(", ")} (refusal: ${refusal})`
        : `no request left the worker; it refused with ${refusal}`,
  };
};

/**
 * Whether a reserved address is SUPPRESSED, rather than refused, where nothing would have been sent.
 *
 * A refusal in a non-delivering process adds no safety — there is no send to stop — and it breaks
 * every local flow that used to complete from the console. No send-attempt detector can see this:
 * in a process with delivery off there is nothing to attempt either way. So this reads the result.
 */
const suppressesWhereDeliveryIsOff = async () => {
  const result = run("npx", ["tsx", "scripts/testing/probes/worker-send-attempt.ts"], {
    ...WORKER_LIKE_ENV,
    APP_ENV: "test",
    NEXT_PUBLIC_APP_ENV: "test",
  });
  const reported = /\{"refusal":.*\}/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);

  if (!reported) {
    throw new Error(
      "worker-send-attempt printed no verdict, so nothing was measured. Tail of its output:\n" +
        `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-600),
    );
  }

  const { refusal } = JSON.parse(reported[0]);

  return {
    refused: refusal === "ReservedRecipientError",
    evidence:
      refusal === "ReservedRecipientError"
        ? "delivery was off and the guard threw anyway, so a flow that would have suppressed now fails"
        : `delivery was off and the address was suppressed as it should be (refusal: ${refusal})`,
  };
};

/**
 * Whether a remote connection string got past the harness into a script's hands.
 *
 * The harness is imported with DATABASE_URL pointed at a host that is plainly not loopback. Guarded,
 * the import throws and nothing downstream runs. Unguarded, the import succeeds and the child prints
 * the remote host it was handed — which is the post-state: a script now holds a string it will write
 * through.
 */
const remoteUrlEscapedTheHarness = async () => {
  const result = run(
    "npx",
    [
      "tsx",
      "-e",
      'import("./scripts/lib/live-harness").then((m) => console.log("ESCAPED " + (m.default ?? m).databaseUrl)).catch((e) => console.log("REFUSED " + e.message));',
    ],
    { DATABASE_URL: "postgres://u:p@ep-probe.ap-southeast-1.aws.neon.tech/db" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // The URL itself, not merely the word after ESCAPED: `tsx -e` exposes this module under `default`,
  // and reading the wrong key printed "ESCAPED undefined" — which the old pattern matched, so the
  // probe reported PROVEN while measuring nothing.
  const escaped = /ESCAPED (postgres\S+)/.exec(output);
  const refused = /REFUSED .*refuses to run against non-local infrastructure/.test(output);

  if (!escaped && !refused) {
    throw new Error(
      `the harness import neither refused nor handed back a URL, so nothing was measured. Output:\n${output.slice(-600)}`,
    );
  }

  return {
    refused: Boolean(escaped),
    evidence: escaped
      ? `the harness handed a script ${escaped[1]}`
      : "the import refused and no connection string reached a script",
  };
};

const vitest = (file) => fails("npx", ["vitest", "run", file]);

// ASSEMBLED FROM PARTS, never written out, for the same reason the check itself does it: this file
// sits under `scripts/`, which the check scans, so a literal here would make it permanently red and
// the probe would be measuring its own text rather than the reintroduction it exists to catch.
const UNOWNED_DOMAIN = ["lombakita", "id"].join(".");

export const probes = [
  {
    name: "the unowned domain reintroduced into a user-facing string fails the run",
    // CLASS D. The guard is a read-only instrument: it reads the repository and reports what it
    // found, so there is no write to reorder and no move analogue. Its harmful move is not a
    // deletion of the check but a REINTRODUCTION of the thing it looks for, and the only honest
    // question is whether it still sees one. The detector reads the result.
    //
    // The mutation is the exact historical defect, restored: a hardcoded support address at the
    // domain the platform does not own, on the page that carried one for months. Mail to it is
    // never received, which is worse than showing no address at all, because it tells a suspended
    // user they have a way to appeal.
    klass: "D",
    harmfulMove:
      "hardcoding a support address at a domain the platform does not own, so an appeal is silently dropped",
    files: ["src/app/suspended/page.tsx"],
    appliedMarkers: [`dukungan@${UNOWNED_DOMAIN}`],
    mutate: () =>
      substituteOnce(
        "src/app/suspended/page.tsx",
        "const SUPPORT_EMAIL = COMPANY.supportEmail;",
        `const SUPPORT_EMAIL = "dukungan@${UNOWNED_DOMAIN}";`,
      ),
    detect: async () => vitest("src/config/unowned-domain.test.ts"),
  },
  {
    name: "verify.yml losing its pull_request trigger fails the run",
    // CLASS C: a workflow gate. The harmful move is the one that looks like tidying — putting the
    // concurrency proof back on the nightly schedule alone, where a broken advisory lock is found
    // the morning AFTER it merged, in a notification nobody opens. Thirteen of fourteen went
    // unread. Removing the trigger breaks nothing that runs, which is exactly why it needs a pin.
    klass: "C",
    harmfulMove:
      "returning the concurrency proof to nightly-only, so a broken lock merges and is reported the next morning",
    files: [".github/workflows/verify.yml"],
    appliedMarkers: ["# probe: pull_request trigger removed"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/verify.yml",
        "  pull_request:\n    branches: [main]\n",
        "  # probe: pull_request trigger removed\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "verify.yml losing the concurrency race step fails the run",
    // CLASS C. The scripts are the ONLY proof the advisory locks exist: the unit suite mocks the
    // database, so `tx.execute` is a no-op and deleting a lock leaves every test green. Delete this
    // step and the job still passes, faster, having proven nothing — the shape this repository has
    // now met often enough to pin every instance of it.
    klass: "C",
    harmfulMove:
      "deleting the only step that can observe an advisory lock, leaving a job that passes having tested nothing",
    files: [".github/workflows/verify.yml"],
    appliedMarkers: ["# probe: race scripts removed"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/verify.yml",
        "        run: npm run verify:concurrency\n",
        "        run: echo '# probe: race scripts removed'\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "verify.yml losing the MFA database-backed suite fails the run",
    klass: "C",
    harmfulMove:
      "deleting the suite that exercises the MFA constraints against a database migrated from zero",
    files: [".github/workflows/verify.yml"],
    appliedMarkers: ["# probe: MFA suite removed"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/verify.yml",
        "        run: npx vitest run src/server/auth/mfa/mfa-schema-db.integration.test.ts\n",
        "        run: echo '# probe: MFA suite removed'\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "verify.yml losing REQUIRE_DB_TESTS fails the run",
    // CLASS C, and the most dangerous of the four because it breaks nothing visible. A
    // database-backed suite that cannot see a database SKIPS, and a skipped suite reports the same
    // green tick as a passing one. Remove this line and the job stays green while testing nothing
    // — which is the exact state DEC-0142 was raised to end.
    klass: "C",
    harmfulMove:
      "letting a database-backed suite skip instead of fail, so the job reports green having measured nothing",
    files: [".github/workflows/verify.yml"],
    appliedMarkers: ["# probe: REQUIRE_DB_TESTS removed"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/verify.yml",
        '      REQUIRE_DB_TESTS: "1"\n',
        "      # probe: REQUIRE_DB_TESTS removed\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "a verify.yml job that is neither required nor declared non-blocking fails the run",
    // CLASS C, and the reason the contexts assertion had to be rewritten rather than loosened when
    // `concurrency races` moved onto the pull-request path. The old assertion compared
    // REQUIRED_CONTEXTS against ci.yml's job names alone, so any job added to verify.yml — running
    // on every pull request, gating nothing — was invisible to it. Set equality across both
    // workflows is what makes an ungated job a decision instead of an omission.
    klass: "C",
    harmfulMove:
      "adding a job that runs on every pull request and can block none of them, without anyone deciding that",
    files: [".github/workflows/verify.yml"],
    appliedMarkers: ["# probe: a job nobody classified"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/verify.yml",
        "  contrast-selftest:\n",
        "  probe-unclassified:\n    # probe: a job nobody classified\n    name: probe unclassified\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n\n  contrast-selftest:\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
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
        '        finding(\n          "wide",\n          `${page.id}|${page.width}|wide|${w.descriptor}`,',
        '        finding(\n          "wide-by-probe",\n          `${page.id}|${page.width}|wide|${w.descriptor}`,',
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
  {
    name: "the mobile audit cannot quietly narrow the widths it measures",
    // The widths ARE the subject, and nothing in the audit can notice one leaving. Readings taken
    // at a dropped width become findings that no longer reproduce, which the run prints as good
    // news on its way to exit 0. The pin is the test, so this is what shows the test does the
    // noticing: with 360 out of the declaration, the ten 360px readings in the committed baseline
    // are recorded at a width nothing declares.
    klass: "D",
    harmfulMove:
      "narrowing the set back towards 390, the one width where the overflowing pages read clean",
    files: ["scripts/testing/lib-browser.mjs"],
    appliedMarkers: ["// probe: 360 dropped"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-browser.mjs",
        "  { width: 360, height: 800 },\n  { width: 375, height: 812 },",
        "  // probe: 360 dropped\n  { width: 375, height: 812 },",
      ),
    // Named down to the one assertion, because the file also pins the widths against a literal
    // triple and that assertion fails first. A probe whose evidence line reads "the set is not
    // [360, 375, 390]" has shown a constant being compared to itself. The claim here is the other
    // one: the baseline still holds readings taken at the width that just left the declaration.
    detect: async () =>
      fails("npx", [
        "vitest",
        "run",
        "scripts/testing/mobile-viewports.test.ts",
        "-t",
        "carries every recorded finding under a declared width",
      ]),
  },
  {
    name: "a recorded finding nothing can compare is refused, not skipped",
    // The fail-open this step was built to remove, one level below where it was removed. The emit
    // gate stops an undeclared finding being written; nothing stopped one already sitting in the
    // baseline, and twelve were. The comparison stepped over each of them and held it to its key,
    // which is the behaviour the magnitude table exists to end.
    klass: "D",
    harmfulMove:
      "skipping the entry, so a page stays allowlisted at any size and a pairing at any ratio",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: uncomparable entries skipped again"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  const unclassifiable = [...baseline.byKey.values()].filter((f) => !isDeclaredFinding(f));",
        "  // probe: uncomparable entries skipped again\n  const unclassifiable = [];",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "the run refuses instead of reporting a verdict on a baseline it cannot compare",
    // Classifying the entry and then printing "none worse than recorded" anyway is a report, not a
    // gate. The same shape as the worsened-findings exit above, and a separate probe for the same
    // reason: identifying a problem and acting on it are two claims.
    klass: "D",
    harmfulMove: "printing the run's verdict anyway, which is the sentence a green run ends with",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: refusal on an uncomparable baseline removed"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  if (unclassifiable.length > 0) {",
        "  // probe: refusal on an uncomparable baseline removed\n  if (false) {",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "a regeneration refuses to carry forward an entry nothing can compare",
    // POST-STATE, and it has to be: with the refusal gone the regeneration succeeds and the entry
    // is copied into the new file, where the next run reads it as a known and permitted state. The
    // exit code and the output are then the ones a correct regeneration produces.
    klass: "B",
    harmfulMove:
      "copying it into the new baseline, where it survives every regeneration and can never acquire a magnitude",
    files: ["scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: uncarriable entries carried anyway"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  const uncarriable = dropping ? [] : carried.filter((f) => !isDeclaredFinding(f));",
        "  // probe: uncarriable entries carried anyway\n  const uncarriable = [];",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]),
    detect: async () => vitest("scripts/testing/audit-baseline.test.ts"),
  },
  {
    name: "the strength gate resolves a helper through every spelling of its import",
    // THE ONE THAT MATTERS. Deleting this line is what blinded the gate the first time, and until
    // now the whole automated suite stayed green over it: the gate itself exits 0 on a clean tree
    // whether or not it can see anything, because on a clean tree there is no weakness to miss.
    klass: "D",
    harmfulMove:
      "resolving an imported identifier to its import specifier, which is every assertion in both harnesses",
    files: ["scripts/testing/assertion-strength.ts"],
    appliedMarkers: ["// probe: alias unwrap removed"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/assertion-strength.ts",
        "  const symbol =\n    local && local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;",
        "  // probe: alias unwrap removed\n  const symbol = local;",
      ),
    detect: async () => vitest("scripts/testing/assertion-resolution.test.ts"),
  },
  {
    name: "a helper the strength gate cannot open is refused, not cleared",
    // INVERTED, and it needs two mutations to say anything: with only the refusal removed there is
    // nothing unresolvable on a clean tree, so the gate would exit 0 either way and the probe would
    // measure nothing. Blinding the resolution first is what creates the condition; the refusal is
    // what makes that condition visible. Red here means the gate cleared 122 assertions it could
    // not read, which is exactly what it used to do.
    klass: "D",
    harmfulMove: "counting an unopenable helper as one with nothing weak inside it",
    files: ["scripts/testing/assertion-strength.ts"],
    appliedMarkers: ["// probe: refusal on an unopenable helper removed"],
    mutate: () => {
      substituteOnce(
        "scripts/testing/assertion-strength.ts",
        "  const symbol =\n    local && local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;",
        "  const symbol = local;",
      );
      substituteOnce(
        "scripts/testing/assertion-strength.ts",
        "  if (unresolved.length > 0) {",
        "  // probe: refusal on an unopenable helper removed\n  if (false) {",
      );
    },
    detect: async () => {
      const result = run("npm", ["run", "verify:assertion-strength"]);
      const output = `${result.stdout}${result.stderr}`;
      const cleared = /\d+ assertions; 0 cannot fail for the reason they name/.test(output);
      return {
        refused: result.status === 0 && cleared,
        evidence:
          result.status === 0 && cleared
            ? "the gate cleared every assertion while unable to open a single helper"
            : `exit ${result.status} — the removal did not reach the verdict`,
      };
    },
  },
  {
    name: "an assertion that never ran fails the harness rather than shrinking its divisor",
    // The `N/M pages clean` defect, in the sibling harness. Seven of r2-flows' assertions sit
    // inside guards, and a skipped one used to leave the numerator and the denominator both one
    // smaller, so a run that checked fifteen of twenty-two reported every one of them passing.
    klass: "D",
    harmfulMove: "reporting a total over what ran, quoted as if it described what was declared",
    files: ["scripts/testing/declared-assertions.mjs"],
    appliedMarkers: ["// probe: unreached assertions no longer named"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/declared-assertions.mjs",
        "  declared.filter((id) => !results.some((result) => result.id === id));",
        "  // probe: unreached assertions no longer named\n  [];",
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/declared-assertions.mjs"]),
    detect: async () => vitest("scripts/testing/declared-assertions.test.ts"),
  },
  {
    name: "the guard probes run in the job branch protection requires",
    klass: "C",
    harmfulMove:
      "removing the step, so every claim that a gate fails when its guard is gone goes back to being checked by hand",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# guard probes removed by probe"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "      - name: Guard probes\n        run: node scripts/testing/probes/config-gates.mjs\n",
        "      # guard probes removed by probe\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "a job renamed out from under its required context fails the run",
    // Branch protection matches a job by its DISPLAY NAME. Rename the job and the context it was
    // required under stops resolving: every pull request blocks on a check nothing will ever
    // report, and it reads as a broken repository rather than as the rename that did it. The
    // opposite edit is worse and the same pin catches it — a job renamed INTO a name nothing
    // requires simply stops gating, silently, which is the defect this whole step is about.
    klass: "C",
    harmfulMove: "renaming a job so its required context can never be satisfied, or never applies",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["name: lint, typecheck, tests"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "    name: lint, typecheck, test\n",
        "    name: lint, typecheck, tests\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "a gating job nothing requires fails the run",
    klass: "C",
    harmfulMove:
      "adding a job that reports a verdict nobody has to wait for, which is running rather than gating",
    files: [".github/workflows/ci.yml"],
    appliedMarkers: ["# probe: a job nothing requires"],
    mutate: () =>
      substituteOnce(
        ".github/workflows/ci.yml",
        "  browser-audits:\n",
        "  probe-only:\n    # probe: a job nothing requires\n    name: probe only\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n\n  browser-audits:\n",
      ),
    detect: async () => vitest("src/config/ci-gates.test.ts"),
  },
  {
    name: "a recipient at a reserved TLD is refused IN THE WORKER — REMOVED",
    // CLASS B, and the post-state is the only thing worth reading here. Both outcomes throw
    // something, so an error-identity detector would report a guard holding whenever anything at
    // all went wrong. What separates them is whether a request to api.resend.com EXISTS: with the
    // refusal there are none, without it there is exactly one.
    //
    // The child runs with APP_ENV=production and RUNTIME_NAME=worker, so delivery is ON. That is
    // the condition a per-process gate keyed on APP_ENV would already have waved through, and it is
    // the process that actually sends — the enqueueing process is not.
    klass: "B",
    harmfulMove:
      "dropping the refusal, so every seeded fixture address is handed to the provider and hard bounces against this sending domain",
    files: ["src/server/email/delivery.ts"],
    appliedMarkers: ["// probe: recipient refusal removed"],
    mutate: () =>
      substituteOnce(
        "src/server/email/delivery.ts",
        "  assertRecipientIsRoutable(context.to, context.kind);\n\n  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };",
        "  // probe: recipient refusal removed\n\n  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };",
      ),
    detect: async () => sentToProviderInWorker(),
  },
  {
    name: "a reserved recipient is SUPPRESSED, not refused, where nothing would be sent — MOVED",
    // NOT A CLASS B MOVE. `resolveEmailDelivery` returns the credential the send requires, so every
    // position inside it precedes the send and no reordering within it can let a message out — the
    // shape Rule 36 says to prefer, where the ordering question is already answered.
    //
    // The move that matters here runs the other way. Lifted ABOVE the suppression branch the guard
    // refuses in processes that were never going to send, which adds no safety and breaks sixteen
    // of the seventeen flows invisibly: three fire-and-forget in process, thirteen inside a worker
    // whose inbox row is already written. That is result content — class D — and the detector reads
    // what the guard did in a NON-delivering process, where the correct answer is suppression.
    klass: "D",
    harmfulMove:
      "checking before the delivery flag, so a process that would never have sent throws instead of suppressing",
    files: ["src/server/email/delivery.ts"],
    appliedMarkers: ["// probe: refusal lifted above the delivery flag"],
    mutate: () => {
      substituteOnce(
        "src/server/email/delivery.ts",
        "  assertRecipientIsRoutable(context.to, context.kind);\n\n  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };",
        "  return { apiKey: serverEnv.resendApiKey, from: serverEnv.authEmailFrom };",
      );
      substituteOnce(
        "src/server/email/delivery.ts",
        "  if (!serverEnv.emailDeliveryEnabled) {",
        "  // probe: refusal lifted above the delivery flag\n  assertRecipientIsRoutable(context.to, context.kind);\n\n  if (!serverEnv.emailDeliveryEnabled) {",
      );
    },
    detect: async () => suppressesWhereDeliveryIsOff(),
  },
  {
    name: "the harness refuses non-local infrastructure — REMOVED",
    // CLASS A1-pre: the guard throws before anything opens a connection, so the harmful move is
    // anywhere BELOW module scope. Detector is the post-state — whether a remote connection string
    // escaped the module into a script's hands — rather than which error came back.
    klass: "A1-pre",
    harmfulMove:
      "deleting the module-scope call, so a script inherits a harness that vetted nothing and writes wherever DATABASE_URL points",
    files: ["scripts/lib/live-harness.ts"],
    appliedMarkers: ["// probe: infrastructure guard removed"],
    mutate: () =>
      substituteOnce(
        "scripts/lib/live-harness.ts",
        "\nassertLocalInfrastructure();",
        "\n// probe: infrastructure guard removed",
      ),
    detect: async () => remoteUrlEscapedTheHarness(),
  },
  {
    name: "the harness refuses non-local infrastructure BEFORE a script can read the URL — MOVED",
    // Moved inside `openPool`, the guard still exists and still refuses — but only for scripts that
    // open their pool through the harness. A script that reads the exported `databaseUrl` and
    // builds its own client is then unguarded, and the import that was supposed to have settled the
    // question returns a remote connection string instead.
    klass: "A1-pre",
    harmfulMove:
      "checking inside openPool, so the exported connection string reaches a script that opens its own",
    files: ["scripts/lib/live-harness.ts"],
    appliedMarkers: ["// probe: infrastructure guard moved into openPool"],
    mutate: () => {
      substituteOnce(
        "scripts/lib/live-harness.ts",
        "\nassertLocalInfrastructure();",
        "\n// probe: infrastructure guard moved into openPool",
      );
      substituteOnce(
        "scripts/lib/live-harness.ts",
        "export const openPool = async (maxConnections: number = POOL_SIZE) => {",
        "export const openPool = async (maxConnections: number = POOL_SIZE) => {\n  assertLocalInfrastructure();",
      );
    },
    detect: async () => remoteUrlEscapedTheHarness(),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe
// set — which files each one mutates, and whether it declares its own compile check — without
// mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
