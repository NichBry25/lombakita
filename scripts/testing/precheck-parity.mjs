/*
 * WHAT /precheck RUNS, AND WHAT CI'S REQUIRED JOB RUNS, DECLARED ONCE SO THE TWO CANNOT DRIFT APART.
 *
 * THE FAILURE THIS EXISTS TO CLOSE, and it has now happened twice in the same shape. LAUNCH-D83:
 * `close-step.md` said "all four checks" while `precheck.md` had carried five since 2026-09-07, and a
 * phase closed on a format-red tree because the instruction the close ran under did not name the
 * check. That was repaired by editing the enumeration — against `precheck.md`. Nothing was asserted,
 * and nothing was compared with CI, so the same class stayed open on the other side: `/precheck` had
 * five checks while CI's required job ran six, and the sixth was the SECRET SCAN. A branch therefore
 * passed all five local checks and failed CI on a credential-shaped fixture, which is only learnable
 * by pushing — the exact thing a pre-submission suite exists to prevent.
 *
 * So the repair is not a sixth check. A sixth check fixes one gap; this file fails the next one.
 *
 * WHAT IS AND IS NOT CLAIMED. This asserts that two ENUMERATIONS agree with the two files that carry
 * them. It does not claim the checks are sufficient, and it cannot: a check absent from both sides is
 * absent from this declaration too. What it removes is the failure where one side gains or loses a
 * step and the other silently does not.
 *
 * EVERY STEP IS CLASSIFIED AND NOTHING IS SKIPPED (Rule 38). A step that is setup rather than a check
 * says so; a check that deliberately runs on one side only carries the reason in `asymmetry`. An
 * undeclared step on either side is a failure, not an omission — that is what makes the count
 * trustworthy rather than merely present.
 */

/**
 * The checks `/precheck` runs, in the order the command file states them.
 *
 * `command` is the exact invocation, because the command is what runs. A step renamed but still
 * running its command stays correct; a step keeping its name while its command changes is a
 * different check wearing an old label, and that is the case worth failing on.
 */
export const PRECHECK_CHECKS = [
  { check: "Lint", command: "npm run lint" },
  { check: "Format", command: "npm run format:check" },
  { check: "Type Check", command: "npm run typecheck" },
  { check: "Tests", command: "npm run test" },
  { check: "Build", command: "npm run build" },
  { check: "Secret scan", command: "npm run verify:secrets" },
];

/**
 * Every step of `ci.yml`'s `lint, typecheck, test` job, in order, with what it is.
 *
 * `kind` is `check` (it can fail the branch on the code's own merits) or `setup` (it prepares the
 * runner and fails only when the runner is wrong). `command` is omitted for a step that runs an
 * inline script or a marketplace action, because there is no single invocation to pin — those are
 * held by name and position alone, which is weaker and is why the list is ordered.
 */
export const REQUIRED_JOB_STEPS = [
  { step: "Checkout", kind: "setup" },
  { step: "Setup Node.js", kind: "setup" },
  { step: "Install dependencies", kind: "setup", command: "npm ci" },
  { step: "Secret scan", kind: "check", command: "npm run verify:secrets" },
  { step: "Lint", kind: "check", command: "npm run lint" },
  { step: "Format", kind: "check", command: "npm run format:check" },
  { step: "Typecheck", kind: "check", command: "npm run typecheck" },
  { step: "Apply migrations", kind: "setup", command: "npm run db:migrate:guarded" },
  { step: "Confirm READ COMMITTED", kind: "setup" },
  { step: "Check out the doc lane", kind: "setup" },
  { step: "Confirm the doc lane holds what the suite reads", kind: "setup" },
  { step: "Test", kind: "check", command: "npm run test" },
  { step: "Assertion strength", kind: "check", command: "npm run verify:assertion-strength" },
  {
    step: "Guard probes",
    kind: "check",
    command: "node scripts/testing/probes/config-gates.mjs",
  },
  {
    step: "Reset guard probes",
    kind: "check",
    command: "node scripts/testing/probes/reset-guard.mjs",
  },
  {
    step: "Probe harness guard probes",
    kind: "check",
    command: "node scripts/testing/probes/harness-guard.mjs",
  },
];

/**
 * Every check one side runs and the other does not, with the reason it is deliberate.
 *
 * A reason is REQUIRED. An asymmetry with no reason is the LAUNCH-D83 shape — two enumerations that
 * disagree and nobody has decided which is right — and the test refuses an entry whose reason is
 * empty rather than accepting the divergence as declared.
 */
export const DECLARED_ASYMMETRIES = [
  {
    command: "npm run build",
    runsIn: "precheck",
    reason:
      "ci.yml states its own reason inline: `next build` needs runtime env (DATABASE_URL, " +
      "AUTH_SECRET, a reachable DB for public-page prerendering) that this job does not hold. It is " +
      "not ungated — `browser audits`, also a required context, runs `npm run build`, and " +
      "deploy-preview's `vercel build` against the real preview env is the authoritative build gate. " +
      "So the branch cannot merge with a broken build; it merely is not THIS job's business.",
  },
  {
    command: "npm run verify:assertion-strength",
    runsIn: "ci",
    reason:
      "A candidate for /precheck rather than a settled asymmetry, recorded so the choice is visible: " +
      "it is fast and needs no database. It is left out today only because adding it was not this " +
      "close's ruling, and a check added without the owner asking is a check nobody decided to run.",
  },
  {
    command: "node scripts/testing/probes/config-gates.mjs",
    runsIn: "ci",
    reason:
      "Rule 36 clause 6 — the probe harness runs only over COMMITTED work and refuses when any file " +
      "it touches differs from HEAD. /precheck runs on an uncommitted tree by definition, so this " +
      "would refuse on every invocation rather than measure anything.",
  },
  {
    command: "node scripts/testing/probes/reset-guard.mjs",
    runsIn: "ci",
    reason:
      "Same clause-6 refusal as the config gates, plus it CREATES AND DROPS real databases to read a " +
      "post-state. Neither belongs in a command run against a working tree between edits.",
  },
  {
    command: "node scripts/testing/probes/harness-guard.mjs",
    runsIn: "ci",
    reason:
      "Same clause-6 refusal as the config gates: it mutates committed files and restores them from " +
      "git, which cannot be told apart from a developer's own uncommitted edits.",
  },
];
