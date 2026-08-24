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
//
// BOUNDED, because an unbounded one has been observed. A probe run left an audit sitting with its
// browser open and no output for sixteen minutes, and `spawnSync` waits for as long as its child
// takes, so the probe suite simply stopped. The bound does not fix that; it turns it into a verdict
// the detector can read. A killed run has no exit code, so every detector here reports "expected
// exit N, got null" and the probe comes back NOT PROVEN, which is what an unfinished measurement
// should look like. One page at three widths takes about six seconds.
const AUDIT_BUDGET_MS = 180000;

const runAudit = (script, filter) =>
  spawnSync("node", [`scripts/testing/${script}`, filter], {
    encoding: "utf8",
    env: { ...process.env, BASE_URL: BASE },
    timeout: AUDIT_BUDGET_MS,
    killSignal: "SIGKILL",
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

/*
 * What an unmeasurable page is made of, for the two probes that need one.
 *
 * It used to be `timeout: 1`, and that mutation deadlocked. A 1ms budget aborts the navigation
 * while the document is still arriving, and Chromium was then left with an in-flight load it never
 * finished: the audit sat with its browser open and produced nothing, on roughly half the runs. A
 * refused connection is the same event without the pathology. Nothing is listening on port 9, the
 * connect fails before a navigation begins, and `page.goto` rejects at once. It is also the closer
 * analogue of the thing being probed, which is a page the audit could not reach.
 */
const NOWHERE = "http://127.0.0.1:9/probe-unmeasurable";
const REACHES_NOWHERE =
  '      await page.goto("http://127.0.0.1:9/probe-unmeasurable", { waitUntil: "domcontentloaded", timeout: 45000 });';
const REACHES_THE_APP =
  '      await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });';

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
    detect: async () =>
      exitedWith(runAudit("mobile-audit.mjs", "^01-home"), STALE_STYLESHEET_EXIT, "freshness"),
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
    detect: async () =>
      exitedWith(runAudit("mobile-audit.mjs", "^01-home"), STALE_STYLESHEET_EXIT, "witness"),
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
        '        await preflightOrRefuse(page, "mobile-audit");',
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
    appliedMarkers: [NOWHERE],
    mutate: () =>
      substituteOnce("scripts/testing/mobile-audit.mjs", REACHES_THE_APP, REACHES_NOWHERE),
    compiles: () => execFileSync("node", ["--check", "scripts/testing/mobile-audit.mjs"]),
    detect: async () =>
      exitedWith(runAudit("mobile-audit.mjs", "^01-home"), UNMEASURABLE_EXIT, "unmeasurable"),
  },
  {
    name: "an unmeasurable page cannot be swallowed by the summary — REMOVED",
    klass: "D",
    harmfulMove: "dropping the branch, so the run goes green having measured nothing",
    files: ["scripts/testing/mobile-audit.mjs", "scripts/testing/lib-audit-baseline.mjs"],
    appliedMarkers: ["// probe: unmeasurable pages tolerated"],
    mutate: () => {
      substituteOnce("scripts/testing/mobile-audit.mjs", REACHES_THE_APP, REACHES_NOWHERE);
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
    // Inverted, and it names the refusal it is watching rather than a bare exit 0. It used to read
    // `status === 0`, which meant it also went green the moment ANY other refusal fired first: the
    // baseline gained entries nothing could compare, that check exited 5 before this one could be
    // judged, and the probe reported the guard as holding when it had never been reached. A probe
    // that cannot tell its own guard from a neighbouring one proves nothing. Red here is the report
    // coming back with three pages nobody measured folded silently into it.
    detect: async () => {
      const result = runAudit("mobile-audit.mjs", "^01-home");
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const refusedAsUnmeasurable =
        result.status === UNMEASURABLE_EXIT && /COULD NOT BE MEASURED/.test(output);
      const reported = REPORT_LINE.test(output);
      return {
        refused: reported && !refusedAsUnmeasurable,
        evidence: refusedAsUnmeasurable
          ? `exit ${result.status} — the removal did not reach the decision`
          : reported
            ? `without the branch the run reported on pages it never measured (exit ${result.status})`
            : `no report produced; exit ${result.status} — the run did not get past the branch`,
      };
    },
  },
  {
    name: "a reading filed under a width it was not taken at fails the run",
    // The finding key names the width. Nothing else in the run does, so if the loop stops setting
    // the viewport it iterates, every reading is a 390px measurement wearing a 360px key and the
    // baseline fills with evidence about a screen nobody looked at. Pinning the widths in a test
    // cannot see this: the declaration would still say three, and the audit would still walk three.
    klass: "B",
    harmfulMove: "measuring at one width while filing the reading under another",
    // The only probe here that needs the audit to MEASURE, which makes it the only one that has to
    // get past the stylesheet preflight. Every probe above restores brand-tokens.css with `git
    // checkout`, and a checkout stamps a fresh mtime, so from the second probe onwards the source
    // looks newer than anything compiled from it and the audit refuses with exit 3. The others
    // never notice because their pages time out before the preflight runs. Backdating undoes the
    // checkout's timestamp without touching a byte of the file, which is why it is listed here as a
    // file this probe touches.
    files: ["scripts/testing/mobile-audit.mjs", TOKENS],
    appliedMarkers: ["// probe: every width measured at the widest"],
    mutate: () => {
      backdateToBuild(TOKENS);
      substituteOnce(
        "scripts/testing/mobile-audit.mjs",
        "    await page.setViewportSize(viewport);",
        "    // probe: every width measured at the widest\n    await page.setViewportSize(MOBILE_VIEWPORTS[2]);",
      );
    },
    detect: async () =>
      exitedWith(runAudit("mobile-audit.mjs", "^01-home"), UNMEASURABLE_EXIT, "viewport mismatch"),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe
// set — which files each one mutates, and whether it declares its own compile check — without
// mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
