/*
 * Rule 36 probes for the two refusals the browser audits gained: they must decline to report a
 * measurement they could not honestly take.
 *
 * Both need an app to point at, and a PRODUCTION build is the honest environment for the first:
 * `next start` serves a stylesheet fixed at build time, so an edit to the source is a real
 * source-versus-served divergence rather than a race with a recompile.
 *
 *   BASE_URL=http://localhost:3100 node scripts/testing/probes/browser-audit-refusals.mjs
 *
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { statSync, utimesSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { refusedWhen } from "./detectors.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const STALE_STYLESHEET_EXIT = 3;
const UNMEASURABLE_EXIT = 4;

// One page, so a probe costs seconds rather than the full inventory. `^01-home` is the landing
// page: anonymous, always present, and the first entry the audits reach.
const runAudit = (script, filter) =>
  spawnSync("node", [`scripts/testing/${script}`, filter], {
    encoding: "utf8",
    env: { ...process.env, BASE_URL: BASE },
  });

/** Both audits print this line when they measure, and only when they measure. */
const REPORT_LINE = /pages clean/;

// A report is the thing a refusal must NOT produce, so its absence is what makes the exit code
// mean "declined to measure" rather than "measured and then fell over".
const exitedWith = (result, code, label) =>
  refusedWhen(result, { status: code, forbidden: REPORT_LINE, label });

/**
 * Backdates a file to the newest compiled CSS chunk.
 *
 * The preflight has two layers and they fail independently. Editing a stylesheet trips the cheap
 * one (the source is newer than anything compiled from it) before the expensive one ever runs, so
 * without this the witness comparison would never be exercised and a probe would report a layer it
 * did not measure.
 */
const backdateToBuild = (path) => {
  const chunk = execFileSync(
    "bash",
    ["-c", "ls -t .next/static/chunks/*.css .next/dev/static/chunks/*.css 2>/dev/null | head -1"],
    { encoding: "utf8" },
  ).trim();
  const { atime, mtime } = statSync(chunk);
  utimesSync(path, atime, mtime);
};

const TOKENS = "src/styles/brand-tokens.css";
const editToken = () =>
  substituteOnce(TOKENS, "  --color-info-surface: #e4ede4;", "  --color-info-surface: #e4ede5;");

export const probes = [
  {
    name: "preflight refuses when a stylesheet edit has not been compiled (freshness layer)",
    klass: "D",
    harmfulMove: "measuring against CSS the source no longer matches, and quoting the number",
    files: [TOKENS],
    appliedMarkers: ["--color-info-surface: #e4ede5;"],
    mutate: editToken,
    detect: async () => exitedWith(runAudit("mobile-audit.mjs", "^01-home"), STALE_STYLESHEET_EXIT, "freshness"),
  },
  {
    name: "preflight refuses on the served bytes even when the timestamps look fine (witness layer)",
    klass: "D",
    harmfulMove: "trusting a timestamp, which any `touch` or checkout reorders",
    files: [TOKENS],
    appliedMarkers: ["--color-info-surface: #e4ede5;"],
    mutate: () => {
      editToken();
      backdateToBuild(TOKENS);
    },
    detect: async () => exitedWith(runAudit("mobile-audit.mjs", "^01-home"), STALE_STYLESHEET_EXIT, "witness"),
  },
  {
    name: "preflight refuses BEFORE the audit measures — REMOVED",
    klass: "D",
    harmfulMove: "deleting the call, so a stale stylesheet produces a full report nobody questions",
    files: [TOKENS, "scripts/testing/mobile-audit.mjs"],
    appliedMarkers: ["// probe: preflight removed"],
    mutate: () => {
      editToken();
      backdateToBuild(TOKENS);
      substituteOnce(
        "scripts/testing/mobile-audit.mjs",
        '      await preflightOrRefuse(page, "mobile-audit");',
        "      // probe: preflight removed",
      );
    },
    compiles: () => execFileSync("node", ["--check", "scripts/testing/mobile-audit.mjs"]),
    // Inverted on purpose: with the guard gone the audit MUST report, and a probe that cannot tell
    // "refused" from "crashed" proves nothing. Red here means the report came back.
    detect: async () => {
      const result = runAudit("mobile-audit.mjs", "^01-home");
      const reported = REPORT_LINE.test(`${result.stdout}${result.stderr}`);
      return {
        refused: reported && result.status !== STALE_STYLESHEET_EXIT,
        evidence: reported
          ? `without the call the audit reported on a stale stylesheet (exit ${result.status})`
          : `no report produced; exit ${result.status} — the removal did not reach the audit`,
      };
    },
  },
  {
    name: "a page that could not be measured fails the run",
    klass: "D",
    harmfulMove: "resolving a timed-out page into the summary count, where it reads as clean",
    files: ["scripts/testing/mobile-audit.mjs"],
    appliedMarkers: ["timeout: 1 }"],
    mutate: () =>
      substituteOnce(
        "scripts/testing/mobile-audit.mjs",
        '    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });',
        '    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 1 });',
      ),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/mobile-audit.mjs"]),
    detect: async () => exitedWith(runAudit("mobile-audit.mjs", "^01-home"), UNMEASURABLE_EXIT, "unmeasurable"),
  },
  {
    name: "an unmeasurable page cannot be swallowed by the summary — REMOVED",
    klass: "D",
    harmfulMove: "dropping the branch, so the run goes green having measured nothing",
    files: ["scripts/testing/mobile-audit.mjs", "scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: unmeasurable pages tolerated"],
    mutate: () => {
      substituteOnce(
        "scripts/testing/mobile-audit.mjs",
        '    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });',
        '    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 1 });',
      );
      substituteOnce(
        "scripts/testing/lib-audit-baseline.mjs",
        "  if (unmeasurable.length > 0) {",
        "  // probe: unmeasurable pages tolerated\n  if (false) {",
      );
    },
    compiles: () => {
      execFileSync("node", ["--check", "scripts/testing/mobile-audit.mjs"]);
      execFileSync("node", ["--check", "scripts/testing/lib-audit-baseline.mjs"]);
    },
    detect: async () => {
      const result = runAudit("mobile-audit.mjs", "^01-home");
      return {
        refused: result.status === 0,
        evidence:
          result.status === 0
            ? "without the branch a run that measured nothing exits 0"
            : `exit ${result.status} — the removal did not reach the decision`,
      };
    },
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe
// set — which files each one mutates, and whether it declares its own compile check — without
// mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
