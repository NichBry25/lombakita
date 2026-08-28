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
// @ts-expect-error — a plain .mjs declaration, shared with the script that checks it against GitHub.
import { REQUIRED_CONTEXTS, jobDisplayNames } from "../../scripts/testing/required-contexts.mjs";

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
    // Both halves of the probe suite. Every gate in this repository is a claim that something goes
    // red when a guard is removed, and the probes are the only thing that has ever checked those
    // claims. Deleting one line from the assertion-strength checker left five gates green,
    // including that checker's own, and nothing but this suite could see it.
    ["the config-gate probes", "node scripts/testing/probes/config-gates.mjs"],
    ["the browser-audit probes", "node scripts/testing/probes/browser-audit-refusals.mjs"],
  ])("runs %s", (_label, command) => {
    expect(runsCommand(command)).toBe(true);
  });

  // The config-gate probes run in the job branch protection requires, so the claims they check are
  // gating today rather than when someone adds another context to the required list. The browser
  // half needs a served app and can only live in the job that has one.
  it("runs the config-gate probes in the required job", () => {
    const required = workflow.slice(
      workflow.indexOf("name: lint, typecheck, test"),
      workflow.indexOf("browser-audits:"),
    );

    expect(required).toContain("node scripts/testing/probes/config-gates.mjs");
  });

  // A grep for the range form found 4 weak assertions; resolving the same file against its parsed
  // syntax tree found 57. The gate is what stops the next one being written.
  it("gates assertion strength", () => {
    expect(runsCommand("npm run verify:assertion-strength")).toBe(true);
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

  // WHICH OF THESE ACTUALLY BLOCKS A MERGE.
  //
  // Both jobs ran on every pull request for weeks while branch protection required one of them,
  // so an audit could exit 1 on a fresh overflow and the pull request stayed mergeable. The list
  // in `required-contexts.mjs` is the declaration; these two pins are the only part of it a test
  // in this repository can prove. Whether GitHub agrees is checked by
  // `npm run verify:branch-protection`, which needs a token this workflow does not carry.
  describe("required contexts", () => {
    const names = jobDisplayNames(workflow) as string[];

    it("requires every job the workflow declares", () => {
      // Adding a gating job and not requiring it is the defect restated, one job later.
      expect(names.length).toBeGreaterThan(0);
      expect([...names].sort()).toEqual([...REQUIRED_CONTEXTS].sort());
    });

    it("requires nothing no job reports", () => {
      // Branch protection matches on the display name. A required context nothing reports under
      // never resolves, so every pull request blocks forever and it reads as a broken repository
      // rather than as the rename that caused it.
      for (const context of REQUIRED_CONTEXTS as string[]) {
        expect(names).toContain(context);
      }
    });
  });
});
