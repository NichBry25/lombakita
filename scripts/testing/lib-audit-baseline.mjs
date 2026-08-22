/*
 * The shared exit contract for the browser audits, and the baseline they measure against.
 *
 * Two problems this closes at once.
 *
 * A REPORT IS NOT A GATE. `contrast-audit` and `mobile-audit` printed their findings and exited 0
 * from birth, so a PR could add an unreadable pairing and every check stayed green. Putting them in
 * CI means they have to be able to FAIL.
 *
 * A PAGE THAT COULD NOT BE MEASURED IS NOT A CLEAN PAGE. Both audits folded a `page.goto` timeout
 * into their summary count — contrast counted the timed-out page as clean outright. Two pages timed
 * out on a real run and one of them was the exact surface a fix had just restructured. An
 * unmeasurable page now ends the run with its own exit code and can never be allowlisted, because
 * the thing a baseline records is a KNOWN FINDING, and "we did not look" is not a finding.
 *
 * Exit codes, so a caller can tell the three apart without parsing the log:
 *   0  measured; nothing outside the baseline
 *   1  measured; findings this baseline does not carry
 *   3  refused to measure — the stylesheet preflight (lib-css-fingerprint.mjs)
 *   4  at least one page could not be measured
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const EXIT_FINDINGS = 1;
export const EXIT_UNMEASURABLE = 4;

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const BASELINE_DIR = join(REPO_ROOT, "scripts/testing/baselines");

export const baselinePath = (name) => join(BASELINE_DIR, `${name}.json`);

/** The recorded findings for `name`, or an empty baseline when none has been taken yet. */
export const readBaseline = (name) => {
  const path = baselinePath(name);
  if (!existsSync(path)) return { takenAt: null, keys: new Set() };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { takenAt: parsed.takenAt, keys: new Set(parsed.findings.map((f) => f.key)) };
};

/**
 * Records the findings of this run as the baseline.
 *
 * Deliberately a separate, explicit act (`UPDATE_BASELINE=1`) rather than something a failing run
 * does for itself: a gate that rewrites its own expectations when it fails is not a gate.
 */
export const writeBaseline = (name, findings, note) => {
  mkdirSync(dirname(baselinePath(name)), { recursive: true });
  const body = {
    audit: name,
    takenAt: new Date().toISOString(),
    note,
    findings: findings.map(({ key, ...rest }) => ({ key, ...rest })),
  };
  writeFileSync(baselinePath(name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`\nBaseline written: ${baselinePath(name)} (${findings.length} finding(s)).`);
};

export const updatingBaseline = process.env.UPDATE_BASELINE === "1";

/**
 * Decides the run's outcome and exits.
 *
 * `unmeasurable` outranks `findings`: a run that could not look at part of the app has not
 * established that the rest is fine, and reporting a finding count from it invites exactly the
 * reading that the count is complete.
 */
export const finishAudit = ({ name, measure, unmeasurable, note }) => {
  // THE REPORT IS PRODUCED HERE, not before the call. An audit that printed its findings and its
  // total on the way to `finishAudit` has already published the number by the time the run is
  // declared invalid, and the number is what gets quoted — which is the whole defect. A probe
  // caught exactly that in the first version of this file: the run exited 4 and printed
  // "N/M pages clean" on its way out.
  if (unmeasurable.length > 0) {
    console.error(`\n${unmeasurable.length} page(s) COULD NOT BE MEASURED:`);
    for (const entry of unmeasurable) {
      console.error(`  ${entry.id.padEnd(34)} ${entry.reason}`);
    }
    console.error(
      `\nThis is a FAILURE, not a lower total. Nothing about these pages was measured, so no ` +
        `count from this run describes them. Re-run; if a page times out repeatedly, it is the ` +
        `page that needs looking at.`,
    );
    process.exit(EXIT_UNMEASURABLE);
  }

  const findings = measure();

  if (updatingBaseline) {
    writeBaseline(name, findings, note);
    return;
  }

  const baseline = readBaseline(name);
  const fresh = findings.filter((f) => !baseline.keys.has(f.key));
  const healed = [...baseline.keys].filter((key) => !findings.some((f) => f.key === key));

  if (healed.length > 0) {
    console.log(
      `\n${healed.length} baselined finding(s) no longer reproduce. Re-take the baseline ` +
        `(UPDATE_BASELINE=1) so they cannot come back unnoticed:`,
    );
    for (const key of healed.slice(0, 10)) console.log(`  FIXED  ${key}`);
  }

  if (fresh.length === 0) {
    console.log(
      `\n${findings.length} finding(s), all of them in the baseline taken ${baseline.takenAt ?? "(never)"}.`,
    );
    return;
  }

  console.error(`\n${fresh.length} finding(s) NOT in the baseline:`);
  for (const finding of fresh) console.error(`  NEW  ${finding.key}`);
  process.exit(EXIT_FINDINGS);
};
