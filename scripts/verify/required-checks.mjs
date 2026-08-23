/*
 * Compares the branch protection on `main` against the checks this repository says must gate it.
 *
 * Not a vitest test, and deliberately: reading protection needs an authenticated admin call, which
 * a pull request's own workflow does not have and a fork's workflow must never have. So the
 * EXPECTATION is version-controlled in src/config/required-checks.ts and pinned by a test that
 * does run in CI, and the comparison against reality lives here for an operator to run.
 *
 * Usage: node scripts/verify/required-checks.mjs [owner/repo]
 * Requires the `gh` CLI, authenticated with admin rights on the repository.
 * Exit code: 0 when every expected check is required; 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Read from the source rather than imported, so this stays runnable under plain node. */
const expectedChecks = () => {
  const source = readFileSync(resolve(REPO_ROOT, "src/config/required-checks.ts"), "utf8");
  const list = source.match(/REQUIRED_STATUS_CHECKS = \[([\s\S]*?)\]/);
  if (!list) throw new Error("could not read REQUIRED_STATUS_CHECKS from src/config");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const repository =
  process.argv[2] ??
  execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

const protection = JSON.parse(
  execFileSync("gh", ["api", `repos/${repository}/branches/main/protection`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }),
);

const required = protection.required_status_checks?.contexts ?? [];
const expected = expectedChecks();
const missing = expected.filter((check) => !required.includes(check));

console.log(`${repository} main — required status checks:`);
for (const check of required) console.log(`  REQUIRED  ${check}`);
for (const check of missing) console.log(`  MISSING   ${check}`);
console.log(`  enforce_admins: ${protection.enforce_admins?.enabled}`);

if (missing.length > 0) {
  console.error(
    `\n${missing.length} check(s) this repository says must gate \`main\` are NOT required, so a ` +
      `pull request they fail is still mergeable. Add them in Settings → Branches → main, or ` +
      `correct src/config/required-checks.ts if the expectation is what changed.`,
  );
  process.exit(1);
}

console.log(`\nAll ${expected.length} expected check(s) are required.`);
