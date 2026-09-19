// @vitest-environment node
//
// /precheck AND CI'S REQUIRED JOB, HELD TO EACH OTHER.
//
// LAUNCH-D83 was two enumerations disagreeing about how many checks /precheck has, and its repair
// edited the prose. Prose was the whole defect: nothing read either sentence, so the same class
// reopened on the other side — /precheck ran five checks where CI's required job ran six, the sixth
// being the secret scan, and the only way to discover that was to push and watch CI go red.
//
// So this reads BOTH files and compares them against one declaration. A step added to CI without
// /precheck gaining it fails here; a check added to /precheck without a CI counterpart fails here
// unless the asymmetry is declared with a reason.
//
// Asserted against each file's TEXT, matching `ci-gates.test.ts`: a YAML parser is a dependency this
// repo does not have and does not need to find a job's step names in order.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PRECHECK_CHECKS,
  REQUIRED_JOB_STEPS,
  DECLARED_ASYMMETRIES,
  // @ts-expect-error — a plain .mjs declaration, read by this test and by nothing else yet.
} from "../../scripts/testing/precheck-parity.mjs";

type PrecheckCheck = { check: string; command: string };
type RequiredStep = { step: string; kind: "check" | "setup"; command?: string };
type Asymmetry = { command: string; runsIn: "precheck" | "ci"; reason: string };

const precheckChecks = PRECHECK_CHECKS as PrecheckCheck[];
const requiredSteps = REQUIRED_JOB_STEPS as RequiredStep[];
const asymmetries = DECLARED_ASYMMETRIES as Asymmetry[];

/**
 * `/precheck` lives in the doc lane, which is its own private repository (Rule 26) and is gitignored
 * in the product repo. Read through `docs/`, exactly as `verify-register.ts` reads `close-step.md`,
 * so the same path works locally (where `.claude` is a symlink into `docs/`) and in CI (where the
 * lane is checked out to `docs/`).
 *
 * A checkout without the lane refuses with one sentence naming the lane rather than an ENOENT out of
 * a parser, because the missing thing is the lane and not the command.
 */
const PRECHECK_PATH = "docs/.claude/commands/precheck.md";

const readPrecheck = (): string => {
  try {
    return readFileSync(resolve(process.cwd(), PRECHECK_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `${PRECHECK_PATH} is not readable: the doc lane (\`docs/\`, its own private repository under ` +
        `Rule 26) is not present in this checkout.`,
    );
  }
};

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

/** Every command `/precheck` tells the reader to run, in the order the file states them. */
const precheckCommands = (text: string): string[] =>
  [...text.matchAll(/^Run: `(.+?)`$/gm)].map((match) => match[1]!);

/**
 * The `lint, typecheck, test` job's block, located by its display name.
 *
 * Refuses rather than returning an empty block: a job this cannot find is a job whose steps it cannot
 * vouch for, and vouching for nothing while reporting green is the defect the whole file is about.
 */
const requiredJobBlock = (): string => {
  const start = workflow.indexOf("    name: lint, typecheck, test\n");
  if (start === -1) {
    throw new Error(
      "ci.yml declares no job named `lint, typecheck, test` — the required context cannot be read, " +
        "so its steps cannot be compared with /precheck's.",
    );
  }
  // The next job begins at the next line indented by exactly two spaces that ends in a colon.
  const rest = workflow.slice(start);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

const jobBlock = requiredJobBlock();

/** Each step's name in the required job, in order. */
const jobStepNames = (): string[] =>
  [...jobBlock.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]!.trim());

/** Whether the required job has a `run:` line invoking exactly this command. */
const jobRunsCommand = (command: string): boolean =>
  new RegExp(`^\\s*run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(
    jobBlock,
  );

const declaredFor = (command: string): Asymmetry | undefined =>
  asymmetries.find((entry) => entry.command === command);

describe("/precheck's enumeration matches the file", () => {
  const text = readPrecheck();

  it("names every declared check, in order, and no others", () => {
    // Both directions in one assertion: a check removed from the file, a check added to the file
    // without being declared, and a reordering all fail here.
    expect(precheckCommands(text)).toEqual(precheckChecks.map((entry) => entry.command));
  });

  it("states its own check count rather than a stale number", () => {
    // LAUNCH-D83's literal defect: the prose said four while the file listed five. The count is
    // spelled, so it is derived here rather than matched against a hardcoded word.
    const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const expected = spelled[precheckChecks.length]!;
    expect(text).toContain(`All ${expected} checks must pass`);
    expect(text).toContain(`passes all ${expected} checks cleanly`);
  });

  it("gives the last check a number matching how many there are", () => {
    expect(text).toContain(`**Check ${precheckChecks.length} — `);
    expect(text).not.toContain(`**Check ${precheckChecks.length + 1} — `);
  });
});

describe("CI's required job matches the declaration", () => {
  it("runs every declared step, in order, and no others", () => {
    expect(jobStepNames()).toEqual(requiredSteps.map((entry) => entry.step));
  });

  it("runs the exact command each declared step names", () => {
    for (const entry of requiredSteps) {
      if (entry.command === undefined) continue;
      expect(
        jobRunsCommand(entry.command),
        `the step \`${entry.step}\` no longer runs \`${entry.command}\``,
      ).toBe(true);
    }
  });
});

describe("the two sides agree, or the difference is declared with a reason", () => {
  const ciChecks = requiredSteps
    .filter((entry) => entry.kind === "check" && entry.command !== undefined)
    .map((entry) => entry.command!);
  const localChecks = precheckChecks.map((entry) => entry.command);

  it("has every CI check either in /precheck or declared as CI-only", () => {
    for (const command of ciChecks) {
      if (localChecks.includes(command)) continue;
      const declared = declaredFor(command);
      expect(
        declared,
        `CI's required job runs \`${command}\` and /precheck does not. Add it to /precheck, or ` +
          `declare the asymmetry in precheck-parity.mjs with the reason it is deliberate.`,
      ).toBeDefined();
      expect(declared!.runsIn).toBe("ci");
    }
  });

  it("has every /precheck check either in CI's required job or declared as local-only", () => {
    for (const command of localChecks) {
      if (jobRunsCommand(command)) continue;
      const declared = declaredFor(command);
      expect(
        declared,
        `/precheck runs \`${command}\` and CI's required job does not. Add it to the job, or ` +
          `declare the asymmetry in precheck-parity.mjs with the reason it is deliberate.`,
      ).toBeDefined();
      expect(declared!.runsIn).toBe("precheck");
    }
  });

  it("carries a real reason for every declared asymmetry, and declares no phantom one", () => {
    for (const entry of asymmetries) {
      // An asymmetry with an empty reason is the D83 shape restated: two enumerations disagreeing
      // with nobody having decided which is right.
      expect(
        entry.reason.trim().length,
        `\`${entry.command}\` is declared with no reason`,
      ).toBeGreaterThan(40);

      // And the asymmetry has to be real. A stale entry claiming a difference that no longer exists
      // would silently permit that command to vanish from the side it is supposed to run on.
      const inLocal = localChecks.includes(entry.command);
      const inCi = jobRunsCommand(entry.command);
      if (entry.runsIn === "precheck") {
        expect(
          inLocal,
          `\`${entry.command}\` is declared precheck-only but /precheck lacks it`,
        ).toBe(true);
        expect(inCi, `\`${entry.command}\` is declared precheck-only but the job runs it too`).toBe(
          false,
        );
      } else {
        expect(inCi, `\`${entry.command}\` is declared CI-only but the job lacks it`).toBe(true);
        expect(inLocal, `\`${entry.command}\` is declared CI-only but /precheck runs it too`).toBe(
          false,
        );
      }
    }
  });

  it("classifies every step, so the counts above are over a known population", () => {
    // Rule 38. A step with no `kind` would be skipped by both directional checks above while the
    // suite reported them as complete.
    for (const entry of requiredSteps) {
      expect(["check", "setup"], `the step \`${entry.step}\` has no kind`).toContain(entry.kind);
    }
    expect(requiredSteps.length).toBe(jobStepNames().length);
  });
});
