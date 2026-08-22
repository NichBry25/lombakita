// @vitest-environment node

// WHAT CI ACTUALLY RUNS.
//
// `ui-states.mjs` is the only mechanism in the repo that verifies a withheld affordance stays
// withheld — eleven surfaces, three shipped anti-patterns caught — and for its whole life it ran on
// one laptop, by hand, when someone remembered. `contrast-audit` is the only thing that can see a
// theme rendering dark-on-dark. Neither had ever run here. Deleting a step from the workflow is a
// one-line edit that nothing else would notice, so each one is pinned.
//
// Asserted against the workflow's TEXT, deliberately: a YAML parser is a dependency this repo does
// not have and does not need for four exact strings.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

/** A `run:` line invoking exactly this command — not a mention of it in a comment. */
const runsCommand = (command: string) =>
  new RegExp(`^\\s*run: ${command.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "m").test(
    workflow,
  );

describe("ci.yml", () => {
  it("runs on every pull request against main", () => {
    expect(workflow).toMatch(/on:\n\s+pull_request:\n\s+branches: \[main\]/);
  });

  it("gates formatting", () => {
    expect(runsCommand("npm run format:check")).toBe(true);
  });

  it.each([
    ["ui state assertions", "node scripts/testing/ui-states.mjs"],
    ["the mobile layout audit", "node scripts/testing/mobile-audit.mjs"],
    ["the contrast and tone-separation audit", "node scripts/testing/contrast-audit.mjs"],
  ])("runs %s", (_label, command) => {
    expect(runsCommand(command)).toBe(true);
  });

  it("seeds the matrix before building the search index", () => {
    const seedAt = workflow.indexOf("node --import tsx scripts/seed-test-matrix.ts");
    const indexAt = workflow.indexOf("node --import tsx scripts/setup-search-index.ts");

    expect(seedAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(-1);
    // The index script backfills from the database in the same pass, so run before the seed it
    // would build an empty index and every search-filtered page would measure no results.
    expect(seedAt).toBeLessThan(indexAt);
  });

  // THE EMAIL HAZARD. The audits are read-only navigations, and `test` never delivers — but the
  // cheapest guarantee is that the job holds no key to send with, and it is the one a future edit
  // is most likely to undo by pasting a secret in "so the email path works".
  it("assigns no Resend credential in any job", () => {
    // The key's NAME appears in the job's own comment explaining why it is absent. What must not
    // exist is an assignment of it.
    expect(workflow).not.toMatch(/^\s*RESEND_API_KEY:/m);
  });

  it("runs the audits under APP_ENV=test", () => {
    expect(workflow).toMatch(/^\s+APP_ENV: test$/m);
  });
});
