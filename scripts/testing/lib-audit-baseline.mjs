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
 *   5  a finding named no declared class, so nothing measured how bad it is — whether it was
 *      emitted by this run, carried forward from another machine, or already sitting in the
 *      committed baseline
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeclaredFinding } from "./finding-classes.mjs";

export const EXIT_FINDINGS = 1;
export const EXIT_UNMEASURABLE = 4;
export const EXIT_UNDECLARED_FINDING = 5;

/**
 * Where this module sits on disk, under either loader that runs it.
 *
 * Plain node gives a `file:` URL. Vite gives a bare path prefixed with `/@fs` and sometimes a query
 * string, because the module is outside its project root. The old `new URL(...).pathname` handled
 * neither: it left percent-encoding in place, so a checkout under a path containing a space
 * resolved to a directory that does not exist, and it carried the `/@fs` prefix straight through —
 * which made the baseline read as EMPTY from any test that imported this file, while every audit
 * running under node read it correctly.
 */
const moduleDirectory = import.meta.url.startsWith("file:")
  ? dirname(fileURLToPath(import.meta.url))
  : dirname(import.meta.url.replace(/^\/@fs/, "").split("?")[0]);

const REPO_ROOT = resolve(moduleDirectory, "../..");
export const BASELINE_DIR = join(REPO_ROOT, "scripts/testing/baselines");

export const baselinePath = (name) => join(BASELINE_DIR, `${name}.json`);

/** The recorded findings for `name`, or an empty baseline when none has been taken yet. */
export const readBaseline = (name) => {
  const path = baselinePath(name);
  if (!existsSync(path)) return { takenAt: null, keys: new Set(), byKey: new Map() };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    takenAt: parsed.takenAt,
    keys: new Set(parsed.findings.map((f) => f.key)),
    byKey: new Map(parsed.findings.map((f) => [f.key, f])),
  };
};

/**
 * Records the findings of this run as the baseline.
 *
 * Deliberately a separate, explicit act (`UPDATE_BASELINE=1`) rather than something a failing run
 * does for itself: a gate that rewrites its own expectations when it fails is not a gate.
 */
export const CURATED_DROP_FLAG = "DROP_CURATED_FINDINGS";

/**
 * The entries a regeneration carries forward instead of deleting.
 *
 * A `seenIn` entry was measured on a machine this run is not — the CI runner reports three
 * institution-public pages overflowing that macOS does not. This run can neither reproduce them nor
 * disprove them, so writing only what it measured DELETES evidence rather than superseding it, and
 * the next CI run fails on findings that were already known and recorded.
 *
 * A README warning would not have fixed this. Prose protecting a destructive default is the same
 * class of guard as the ones this step exists to repair.
 */
const curatedCarryOver = (previous, measuredKeys) =>
  [...previous.byKey.values()].filter((f) => f.seenIn && !measuredKeys.has(f.key));

export const writeBaseline = (name, findings, note) => {
  const measured = findings.map(({ key, ...rest }) => ({ key, ...rest }));
  const measuredKeys = new Set(measured.map((f) => f.key));
  const carried = curatedCarryOver(readBaseline(name), measuredKeys);
  const dropping = process.env[CURATED_DROP_FLAG] === "1";

  // REFUSED, not carried. A carried entry is the one thing here that never passes the emit gate:
  // it is copied out of the previous file and into the new one, so an entry with no class and no
  // magnitude survives every regeneration and can never acquire one. Six such entries were carried
  // forward on this branch, muting three pages by key alone under a green run. Dropping is the
  // documented escape and stays open, because a dropped entry is deleted rather than kept in a
  // state nothing can compare.
  const uncarriable = dropping ? [] : carried.filter((f) => !isDeclaredFinding(f));
  if (uncarriable.length > 0) {
    console.error(
      `\n${uncarriable.length} finding(s) recorded on another machine carry no declared class ` +
        `and magnitude, so this regeneration would copy forward an entry nothing can compare:`,
    );
    for (const f of uncarriable) {
      console.error(
        `  UNCARRIABLE  ${f.key}  class=${f.class ?? "(none)"} magnitude=${f.magnitude}`,
      );
    }
    console.error(
      `\nGive each one the class its key names and the magnitude the machine that recorded it ` +
        `measured, or drop it with ${CURATED_DROP_FLAG}=1. Carrying it forward is how it stays ` +
        `uncomparable for another regeneration.`,
    );
    process.exit(EXIT_UNDECLARED_FINDING);
  }

  mkdirSync(dirname(baselinePath(name)), { recursive: true });
  const body = {
    audit: name,
    takenAt: new Date().toISOString(),
    note,
    findings: dropping ? measured : [...measured, ...carried],
  };
  writeFileSync(baselinePath(name), `${JSON.stringify(body, null, 2)}\n`);

  console.log(`\nBaseline written: ${baselinePath(name)} (${body.findings.length} finding(s)).`);
  if (carried.length === 0) return;

  if (dropping) {
    console.log(`  ${carried.length} finding(s) from another machine DROPPED at your request:`);
    for (const f of carried) console.log(`  DROPPED  ${f.seenIn}  ${f.key}`);
    return;
  }
  console.log(
    `  ${carried.length} finding(s) recorded on another machine were CARRIED OVER, because this ` +
      `run could not have reproduced them. To drop them, re-run with ${CURATED_DROP_FLAG}=1.`,
  );
  for (const f of carried) console.log(`  KEPT  ${f.seenIn}  ${f.key}`);
};

export const updatingBaseline = process.env.UPDATE_BASELINE === "1";
/**
 * Splits this run's findings three ways against the baseline: never seen before, seen before and
 * now worse, and recorded but no longer reproducing.
 *
 * `magnitude` is how bad a finding is in the audit's own unit, where HIGHER IS WORSE. It exists
 * because a key alone says a page has a fault of some KIND and nothing about the SIZE of it: a page
 * baselined for horizontal overflow at 621px stays baselined at 900px, so the allowlist mutes a
 * dimension of the page rather than the defect that was measured on it, and every later regression
 * from any cause is pre-absorbed. A finding that carries a magnitude is therefore held to it —
 * same key, larger number, the run fails.
 *
 * A SMALLER number is not a failure. That is the fix landing, and it stays green until someone
 * re-takes the baseline.
 *
 * A RECORDED ENTRY NOTHING CAN CLASSIFY IS REFUSED, NOT SKIPPED, and that is the difference between
 * this being a gate and being a report. Skipping it was the fail-open: twelve entries across the
 * two committed baselines carried no magnitude, the comparison stepped over them, and they were
 * held to their key alone — which is the exact behaviour the magnitude table was added to end. A
 * tone pairing could decay from 9.92 to 0.5 and three pages could go from 400px of overflow to
 * 900px, under a green run, on the branch that claims to have closed it. The skip below still
 * exists so the loop cannot compare against a number that is not there; what changed is that the
 * entry now leaves through `unclassifiable`, and the caller has to act on it.
 */
export const classifyAgainstBaseline = (findings, baseline) => {
  const unclassifiable = [...baseline.byKey.values()].filter((f) => !isDeclaredFinding(f));

  const fresh = findings.filter((f) => !baseline.keys.has(f.key));

  const worsened = [];
  for (const finding of findings) {
    const recorded = baseline.byKey.get(finding.key);
    if (!recorded) continue;
    if (!isDeclaredFinding(recorded)) continue;
    if (!isDeclaredFinding(finding)) continue;
    if (finding.magnitude <= recorded.magnitude) continue;
    worsened.push({ key: finding.key, was: recorded.magnitude, now: finding.magnitude });
  }

  const healed = [...baseline.keys].filter((key) => !findings.some((f) => f.key === key));

  return { fresh, worsened, healed, unclassifiable };
};

/**
 * Decides the run's outcome and exits.
 *
 * `unmeasurable` outranks `findings`: a run that could not look at part of the app has not
 * established that the rest is fine, and reporting a finding count from it invites exactly the
 * reading that the count is complete.
 */
/**
 * Every finding names a class this repository has declared, and carries the magnitude that class
 * says how to measure.
 *
 * `finding()` already refuses an undeclared class at the emit site. This is the collection point
 * saying the same thing, so a finding assembled by hand — the way all of them used to be — cannot
 * reach a baseline with no severity attached. That is the state the whole table exists to make
 * impossible, and a check only at the emit site would leave it one object literal away.
 */
const assertEveryFindingIsDeclared = (findings) => {
  const undeclared = findings.filter((f) => !isDeclaredFinding(f));
  if (undeclared.length === 0) return;

  console.error(`\n${undeclared.length} finding(s) carry no declared class and magnitude:`);
  for (const f of undeclared.slice(0, 10)) {
    console.error(`  UNDECLARED  ${f.key}  class=${f.class ?? "(none)"} magnitude=${f.magnitude}`);
  }
  console.error(
    `\nA finding whose severity nothing measures can only ever be compared by key, which lets it ` +
      `worsen without limit under a green run. Build it with finding() from finding-classes.mjs, ` +
      `and declare the class there if it is new.`,
  );
  process.exit(EXIT_UNDECLARED_FINDING);
};

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
  assertEveryFindingIsDeclared(findings);

  if (updatingBaseline) {
    writeBaseline(name, findings, note);
    return;
  }

  const baseline = readBaseline(name);
  const { fresh, worsened, healed, unclassifiable } = classifyAgainstBaseline(findings, baseline);

  // BEFORE any of the three reports below. Every one of them is a statement about this run measured
  // against the baseline, and a baseline carrying entries nothing can compare does not support any
  // of them. "None worse than recorded" is the sentence that must not be printed here.
  if (unclassifiable.length > 0) {
    console.error(
      `\n${unclassifiable.length} recorded finding(s) carry no declared class and magnitude, so ` +
        `this run cannot say whether they got worse:`,
    );
    for (const f of unclassifiable.slice(0, 12)) {
      console.error(
        `  UNCLASSIFIABLE  ${f.key}  class=${f.class ?? "(none)"} magnitude=${f.magnitude}`,
      );
    }
    if (unclassifiable.length > 12) {
      console.error(`  UNCLASSIFIABLE  …and ${unclassifiable.length - 12} more`);
    }
    console.error(
      `\nAn entry held to its key alone is muted, not baselined: the page stays allowlisted at ` +
        `any size and the pairing at any ratio. Give each one the class its key names and the ` +
        `magnitude the run that recorded it measured. Where that run was another machine, the ` +
        `number has to come from that machine.`,
    );
    process.exit(EXIT_UNDECLARED_FINDING);
  }

  if (healed.length > 0) {
    console.log(
      `\n${healed.length} baselined finding(s) did not reproduce in this run. Either they were ` +
        `fixed — re-take the baseline (UPDATE_BASELINE=1) so they cannot come back unnoticed — or ` +
        `this environment renders differently from the one that recorded them, which the baseline ` +
        `marks with seenIn:`,
    );
    for (const key of healed.slice(0, 10)) console.log(`  NOT SEEN  ${key}`);
    if (healed.length > 10) console.log(`  NOT SEEN  …and ${healed.length - 10} more`);
  }

  if (worsened.length > 0) {
    console.error(`\n${worsened.length} baselined finding(s) measured WORSE than when recorded:`);
    for (const entry of worsened) {
      console.error(`  WORSE  ${entry.key.padEnd(48)} ${entry.was} → ${entry.now}`);
    }
  }

  if (fresh.length > 0) {
    console.error(`\n${fresh.length} finding(s) NOT in the baseline:`);
    for (const finding of fresh) console.error(`  NEW  ${finding.key}`);
  }

  if (fresh.length > 0 || worsened.length > 0) {
    process.exit(EXIT_FINDINGS);
  }

  console.log(
    `\n${findings.length} finding(s), all of them in the baseline taken ` +
      `${baseline.takenAt ?? "(never)"}, none worse than recorded.`,
  );
};
