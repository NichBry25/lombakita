/*
 * Checks that GitHub is actually requiring the contexts this repository declares.
 *
 * NOT A CI GATE, and calling it one would repeat the exact defect this apparatus exists to close.
 * Reading branch protection needs a token with admin scope; the workflow's GITHUB_TOKEN does not
 * carry one, and a check that cannot fail on the misconfiguration it names is worse than no check,
 * because it reports success. Run it by hand (`npm run verify:branch-protection`) or from somewhere
 * that holds such a token.
 *
 * What DOES run on every pull request is the pin in `src/config/ci-gates.test.ts`, which proves the
 * declaration matches the jobs that exist. Nothing in the repository can prove GitHub agrees.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_CONTEXTS, jobDisplayNames } from "./required-contexts.mjs";

const BRANCH = "main";

const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/{owner}/{repo}/branches/${BRANCH}/protection${path}`], {
      encoding: "utf8",
    }),
  );

const complaints = [];

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const declaredButNotAJob = REQUIRED_CONTEXTS.filter((c) => !jobDisplayNames(workflow).includes(c));
for (const context of declaredButNotAJob) {
  // A required context no job reports blocks every pull request forever, which reads as a broken
  // repository rather than as a misconfiguration, so it is worth naming before asking GitHub.
  complaints.push(`"${context}" is required but no job in ci.yml reports under that name`);
}

const checks = api("/required_status_checks");
const live = (checks.checks ?? []).map((check) => check.context);
for (const context of REQUIRED_CONTEXTS) {
  if (!live.includes(context)) complaints.push(`"${context}" is not in the required list`);
}
if (checks.strict !== true) {
  complaints.push("stale branches are mergeable: required_status_checks.strict is not true");
}

const admins = api("/enforce_admins");
if (admins.enabled !== true) {
  // Without this every gate above is advisory for whoever holds admin, which is how the branch
  // model came to be documented as enforced while a direct push was still possible.
  complaints.push("administrators can bypass every required check: enforce_admins is not enabled");
}

if (complaints.length > 0) {
  console.error(`${BRANCH} branch protection does not match what this repository declares:`);
  for (const complaint of complaints) console.error(`  ${complaint}`);
  process.exit(1);
}

console.log(`${BRANCH} requires ${live.map((c) => `"${c}"`).join(", ")}, strict, no admin bypass.`);
