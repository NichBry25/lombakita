/*
 * The Rule 36 probe harness.
 *
 * A guard that has never been observed refusing is a guard that has been ASSUMED. The way to
 * observe one is to break it deliberately and watch the detector go red — but a probe run by hand
 * is itself unverified apparatus, and Step 7.2-MANUAL.2 produced eight distinct ways an ad-hoc
 * probe reports a result it did not measure. Every clause below is one of those eight, made
 * mechanical so it cannot be skipped by whoever is in a hurry.
 *
 *   COMPILES      a mutation that does not parse proves the parser refuses, not the guard.
 *   APPLIED       the file on disk must actually differ, and carry the mutation's own text.
 *   REACHED       the detector must be shown to have executed and produced a verdict, not to have
 *                 crashed early into a catch that reads as "no finding".
 *   RESTORE       from git, per file, with `git diff --quiet` asserted afterwards — never from a
 *                 copy held in memory, which is lost the moment the process dies.
 *   FILE LIST     explicit. `git checkout -- .`, `git reset --hard` and `git clean` are absent
 *                 from this file on purpose and must stay absent.
 *   COMMITTED     the listed files must be clean before anything is written, so a restore can
 *                 never discard uncommitted work.
 *
 * Teardown runs in a `finally` AND from signal handlers (Rule 35): the failure mode this is built
 * against is a probe that leaves the tree mutated because someone hit Ctrl-C while it measured.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** True when the working tree matches HEAD for exactly these paths. */
const pathsClean = (files) => {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...files], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Restores exactly the named files from HEAD.
 *
 * `--` and an explicit list, always. A path-less restore in this position is what turns a probe
 * into an incident: it would discard every unrelated edit in the tree, and the probe would report
 * success while doing it.
 */
const restoreFromGit = (files) => {
  execFileSync("git", ["checkout", "HEAD", "--", ...files], { stdio: "ignore" });
};

/** Registered so a Ctrl-C during measurement cannot leave a mutated file behind. */
const onSignal = new Map();
// Registered once for the life of the process, not once per probe. Keying off the map's size
// re-registers on every probe after the first, because each probe's teardown empties the map
// again — a thirteen-probe suite ended up with eleven handlers and a listener-leak warning.
let signalTeardownInstalled = false;
const installSignalTeardown = (key, teardown) => {
  onSignal.set(key, teardown);
  if (signalTeardownInstalled) return;
  signalTeardownInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const run of onSignal.values()) {
        try {
          run();
        } catch {
          /* a teardown that throws must not stop the others */
        }
      }
      process.exit(130);
    });
  }
};

export const readFile = (path) => readFileSync(path, "utf8");

/**
 * Replaces `find` with `replace` in `path`, once, failing loudly when the anchor is not there.
 *
 * A mutation whose anchor has drifted writes nothing and the probe then measures an unmutated
 * file, which reads exactly like a guard that held.
 */
export const substituteOnce = (path, find, replace) => {
  const before = readFileSync(path, "utf8");
  const first = before.indexOf(find);
  if (first === -1) {
    throw new Error(`mutation anchor not found in ${path}: ${JSON.stringify(find.slice(0, 80))}`);
  }
  if (before.indexOf(find, first + find.length) !== -1) {
    throw new Error(
      `mutation anchor is ambiguous in ${path}: ${JSON.stringify(find.slice(0, 80))}`,
    );
  }
  writeFileSync(path, before.slice(0, first) + replace + before.slice(first + find.length));
};

/**
 * Runs one probe.
 *
 * @param {object} spec
 * @param {string} spec.name            what is being proven, in the log
 * @param {string} spec.harmfulMove     the move the guard exists to stop, named BEFORE the detector
 * @param {"A1-in"|"A1-pre"|"A2"|"B"|"C"|"D"} spec.klass  guard class, per Rule 36
 * @param {string[]} spec.files         every file the mutation touches — explicit, never a glob
 * @param {() => void|Promise<void>} spec.mutate      applies the harmful move
 * @param {string[]} spec.appliedMarkers text each mutated file must now contain
 * @param {() => void|Promise<void>} [spec.compiles]  parses/typechecks the mutated files
 * @param {() => Promise<{refused: boolean, evidence: string}>} spec.detect
 * @returns {Promise<{name: string, ok: boolean, detail: string}>}
 */
export const runProbe = async (spec) => {
  const { name, harmfulMove, klass, files, mutate, appliedMarkers, compiles, detect } = spec;

  if (!files?.length) throw new Error(`${name}: probe has no explicit file list`);

  // CLAUSE 6 — committed work only. A restore is a destructive operation against these paths, and
  // it is only safe when HEAD already holds what is on disk.
  if (!pathsClean(files)) {
    throw new Error(
      `${name}: refusing to probe. These files differ from HEAD, and the restore afterwards would ` +
        `discard that work: ${files.join(", ")}. Commit or stash first.`,
    );
  }

  const teardown = () => restoreFromGit(files);
  installSignalTeardown(name, teardown);

  let detail = "";
  let ok = false;
  try {
    await mutate();

    // CLAUSE 2 — applied. Both halves: the tree must differ from HEAD, and each marker must be on
    // disk. The first alone passes on a whitespace edit; the second alone passes on a marker that
    // was already there.
    if (pathsClean(files)) {
      throw new Error(`${name}: mutation left the tree identical to HEAD — nothing was probed`);
    }
    for (const marker of appliedMarkers) {
      const found = files.some((file) => readFileSync(file, "utf8").includes(marker));
      if (!found) {
        throw new Error(`${name}: mutation marker absent after mutating: ${marker.slice(0, 80)}`);
      }
    }

    // CLAUSE 1 — compiles. Optional only where the mutated file is not code.
    if (compiles) await compiles();

    // CLAUSE 3 — reached. `detect` returns a verdict object; a detector that threw or returned
    // nothing did not measure, and must not be read as "the guard held".
    const verdict = await detect();
    if (!verdict || typeof verdict.refused !== "boolean") {
      throw new Error(`${name}: detector produced no verdict — it did not reach its assertion`);
    }
    ok = verdict.refused;
    detail = verdict.evidence;
  } finally {
    // CLAUSE 4 — restore from git, then prove it. Inside `finally` so a throwing detector cannot
    // leave the mutation behind.
    onSignal.delete(name);
    teardown();
    if (!pathsClean(files)) {
      throw new Error(
        `${name}: RESTORE FAILED — ${files.join(", ")} still differ from HEAD after checkout. ` +
          `Fix the tree by hand before running anything else.`,
      );
    }
  }

  console.log(
    `${ok ? "RED  " : "GREEN"}  ${name}\n` +
      `        class ${klass} — harmful move: ${harmfulMove}\n` +
      `        ${detail}\n` +
      `        RESTORE OK (${files.length} file(s) match HEAD)`,
  );
  return { name, ok, detail };
};

/**
 * Runs a list of probes and exits non-zero unless EVERY one went red.
 *
 * A probe suite that tolerates a green probe is a suite that tolerates an unproven guard.
 */
export const runProbes = async (probes) => {
  const results = [];
  for (const probe of probes) {
    results.push(await runProbe(probe));
  }
  const green = results.filter((r) => !r.ok);
  console.log(`\n${results.length - green.length}/${results.length} probes went red as claimed.`);
  if (green.length > 0) {
    for (const r of green) {
      console.error(
        `NOT PROVEN: ${r.name} — the guard did not refuse when its premise was broken.`,
      );
    }
    process.exit(1);
  }
};

export { git, pathsClean };
