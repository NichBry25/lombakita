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
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { transform as parseCss } from "lightningcss";

/**
 * Which repository a probe's files live in.
 *
 * `docs/` is a git repository in its own right (Rule 26), nested inside a product repository that
 * ignores it (DEC-0101). A probe that mutates a register therefore cannot be restored by a git
 * rooted at the product repository: `ls-files` does not know the file, `diff HEAD` reports it clean
 * because it is ignored, and the `checkout` that follows fails — and that failure throws from the
 * `finally`, which is the one place a throw leaves the mutation on disk.
 *
 * A probe declares its repository, and every git call and every file read resolves against it. The
 * paths stay in ONE space — relative to the WORKING DIRECTORY, which is what a reader sees in the
 * list — and are translated to the repository's own space only at the git boundary.
 */
const repoRelative = (repo, file) => {
  if (repo === undefined) return file;
  const within = relative(repo, file);
  if (within === "" || within.startsWith("..") || within.includes(`..${sep}`)) {
    throw new Error(
      `this probe declares its repository as ${repo}, but lists ${file}, which is not inside it. ` +
        `A path that git cannot address in that repository is a path the restore cannot undo.`,
    );
  }
  return within;
};

/**
 * Every git call in this file, so the repository decision lives in exactly one place.
 *
 * `encoding` and the trim serve the callers that READ output. A caller interested only in the exit
 * status passes `stdio: "ignore"` and reads the throw — in that mode there is no captured stdout,
 * so the null it returns is normalised here rather than at four call sites.
 */
const git = (args, repo, options = {}) => {
  const stdout = execFileSync("git", repo === undefined ? args : ["-C", repo, ...args], {
    encoding: "utf8",
    ...options,
  });
  return stdout === null ? "" : stdout.trim();
};

/**
 * Every listed path is TRACKED.
 *
 * `git diff --quiet HEAD --` says nothing about a path git has never seen, so an untracked file
 * passes the clean check, gets mutated, and then cannot be restored — and the restore failure
 * throws from the `finally`, which is the one place a throw leaves the mutation on disk. Found by
 * the probe that proves clause 1: its fixture was new, and the harness reported a git error where
 * the compile refusal should have been.
 */
const assertTracked = (files, repo) => {
  const untracked = files.filter((file) => {
    try {
      git(["ls-files", "--error-unmatch", "--", repoRelative(repo, file)], repo, {
        stdio: "ignore",
      });
      return false;
    } catch {
      return true;
    }
  });
  if (untracked.length > 0) {
    throw new Error(
      `refusing to probe. git does not track these, so a mutation to them could not be undone: ` +
        `${untracked.join(", ")}. Commit them first.`,
    );
  }
};

/** True when the working tree matches HEAD for exactly these paths. */
const pathsClean = (files, repo) => {
  try {
    git(["diff", "--quiet", "HEAD", "--", ...files.map((file) => repoRelative(repo, file))], repo, {
      stdio: "ignore",
    });
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
const restoreFromGit = (files, repo) => {
  git(["checkout", "HEAD", "--", ...files.map((file) => repoRelative(repo, file))], repo, {
    stdio: "ignore",
  });
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
 * What the mutation did to the tree, read out of git rather than taken from the probe's own name.
 *
 * A removal/move pair names the same guard twice, so the case name alone cannot say which of the
 * two ran, and the evidence line for the pair reads as one result printed twice. The diff separates
 * them without anyone having to describe it: a removal only takes lines away, a move takes the same
 * lines away and puts them back somewhere else, so the counts differ and the added line is there to
 * read. Captured while the file is still mutated, which is the only moment it exists.
 */
const mutationIdentity = (files, repo) => {
  const diff = git(
    ["diff", "--unified=0", "HEAD", "--", ...files.map((file) => repoRelative(repo, file))],
    repo,
  );

  const removed = [];
  const added = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1).trim());
    else if (line.startsWith("+")) added.push(line.slice(1).trim());
  }

  const firstReal = (lines) => lines.find((line) => line !== "");
  const excerpt = (lines) => {
    const line = firstReal(lines);
    return line === undefined ? "(nothing)" : JSON.stringify(line.slice(0, 64));
  };

  return (
    `mutation -${removed.length}/+${added.length} lines` +
    `  first removed ${excerpt(removed)}` +
    `  first added ${excerpt(added)}`
  );
};

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
 * @param {string} [spec.repo]          the git repository the files belong to, when it is not the
 *                                      one the process is sitting in. See `repoRelative`.
 * @param {() => void|Promise<void>} spec.mutate      applies the harmful move
 * @param {string[]} spec.appliedMarkers text each mutated file must now contain
 * @param {() => void|Promise<void>} [spec.compiles]  parses/typechecks the mutated files
 * @param {() => Promise<{refused: boolean, evidence: string}>} spec.detect
 * @returns {Promise<{name: string, ok: boolean, detail: string}>}
 */
/**
 * HOW EACH KIND OF FILE IS SHOWN TO PARSE.
 *
 * The probe harness's declared subject. A probe may still bring its own `compiles`, but it may not
 * bring none: an extension that appears in neither table is a refusal rather than a wave-through,
 * because "nobody decided whether this is code" is exactly how the clause became skippable.
 */
export const CODE_CHECKS = {
  ".mjs": (file) => execFileSync("node", ["--check", file], { stdio: "pipe" }),
  ".js": (file) => execFileSync("node", ["--check", file], { stdio: "pipe" }),
  ".cjs": (file) => execFileSync("node", ["--check", file], { stdio: "pipe" }),
  // No per-file mode survives this project's path aliases, so a TypeScript mutation is checked by
  // the same command the repository's own gate runs.
  ".ts": () => execFileSync("npx", ["tsc", "--noEmit"], { stdio: "pipe" }),
  ".tsx": () => execFileSync("npx", ["tsc", "--noEmit"], { stdio: "pipe" }),
  ".mts": () => execFileSync("npx", ["tsc", "--noEmit"], { stdio: "pipe" }),
  // The parser the build itself uses. A stylesheet mutation that does not parse changes which
  // RULES exist rather than which VALUES they carry, and that is a different experiment from the
  // one a preflight probe claims to run.
  ".css": (file) => parseCss({ filename: file, code: readFileSync(file), minify: false }),
};

/** Data, not code. A `.json` is still parsed: invalid JSON is the same trap in a different suit. */
export const DATA_CHECKS = {
  ".json": (file) => JSON.parse(readFileSync(file, "utf8")),
  ".yml": () => undefined,
  ".yaml": () => undefined,
  /**
   * A register is prose that its reader parses STRUCTURALLY, and what "parses" means for it depends
   * on which reader — the census in `scripts/project` for the two project registers, something else
   * for any other markdown. This file is shared infrastructure and does not know what a given
   * markdown file is for, so it does not pretend to decide that. The meaningful check is already
   * mechanical one layer up: clause 3 requires the detector to NAME the assertion it reached, so a
   * mutation that makes a register unclassifiable throws there instead of being read as a guard that
   * held. What is checked here is the weaker property that still has to hold — the bytes are
   * readable text, so a truncated or NUL-filled write is a refusal rather than a verdict.
   */
  ".md": (file) => {
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") throw new Error(`${file} is empty`);
    if (text.includes("\0")) throw new Error(`${file} is not text`);
  },
};

export const extensionOf = (file) => {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot);
};

/** True when a mutation to this file has to be shown to parse before its detector is believed. */
export const isCodeFile = (file) => extensionOf(file) in CODE_CHECKS;

/**
 * The check that shows a mutation to `file` still parses.
 *
 * Throws for an extension in neither table, so a probe cannot be run against a file kind nobody has
 * classified. Exported because it IS the declaration: a test asserts every file every probe mutates
 * resolves through it.
 */
export const compileCheckFor = (file) => {
  const extension = extensionOf(file);
  const check = CODE_CHECKS[extension] ?? DATA_CHECKS[extension];
  if (!check) {
    throw new Error(
      `no compile check is declared for ${file}. Add its extension to CODE_CHECKS or DATA_CHECKS ` +
        `in guard-probe.mjs, or give the probe an explicit \`compiles\`.`,
    );
  }
  return () => check(file);
};

const defaultCompileCheckFor = (name, files) => async () => {
  for (const file of files) {
    try {
      compileCheckFor(file)();
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  }
};

export const runProbe = async (spec) => {
  const { name, harmfulMove, klass, files, repo, mutate, appliedMarkers, compiles, detect } = spec;

  if (!files?.length) throw new Error(`${name}: probe has no explicit file list`);

  assertTracked(files, repo);

  // CLAUSE 6 — committed work only. A restore is a destructive operation against these paths, and
  // it is only safe when HEAD already holds what is on disk.
  if (!pathsClean(files, repo)) {
    throw new Error(
      `${name}: refusing to probe. These files differ from HEAD, and the restore afterwards would ` +
        `discard that work: ${files.join(", ")}. Commit or stash first.`,
    );
  }

  const teardown = () => restoreFromGit(files, repo);
  installSignalTeardown(name, teardown);

  let detail = "";
  let identity = "";
  let ok = false;
  try {
    await mutate();

    // CLAUSE 2 — applied. Both halves: the tree must differ from HEAD, and each marker must be on
    // disk. The first alone passes on a whitespace edit; the second alone passes on a marker that
    // was already there.
    if (pathsClean(files, repo)) {
      throw new Error(`${name}: mutation left the tree identical to HEAD — nothing was probed`);
    }
    for (const marker of appliedMarkers) {
      const found = files.some((file) => readFileSync(file, "utf8").includes(marker));
      if (!found) {
        throw new Error(`${name}: mutation marker absent after mutating: ${marker.slice(0, 80)}`);
      }
    }

    identity = mutationIdentity(files, repo);

    // CLAUSE 1 — compiles. NOT optional for a code file, because most detectors here are `vitest`
    // or `tsc`, which fail identically on a syntax error and on a guard holding: a probe whose
    // mutation did not parse cannot say which of the two it observed. It was opt-in, and eight of
    // thirteen probes were opting out.
    await (compiles ?? defaultCompileCheckFor(name, files))();

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
    if (!pathsClean(files, repo)) {
      throw new Error(
        `${name}: RESTORE FAILED — ${files.join(", ")} still differ from HEAD after checkout. ` +
          `Fix the tree by hand before running anything else.`,
      );
    }
  }

  console.log(
    `${ok ? "RED  " : "GREEN"}  ${name}\n` +
      `        class ${klass} — harmful move: ${harmfulMove}\n` +
      `        ${identity}\n` +
      `        ${detail}\n` +
      `        RESTORE OK (${files.length} file(s) match HEAD)`,
  );
  return { name, ok, detail, identity };
};

/**
 * Runs a list of probes and exits non-zero unless EVERY one went red.
 *
 * A probe suite that tolerates a green probe is a suite that tolerates an unproven guard.
 */
/**
 * The green precondition: every gate the suite's probes run must be PASSING before the first probe
 * runs. A suite seated over a gate that was already red reports the same red for a reason that has
 * nothing to do with the mutation, and the two are indistinguishable in the output.
 *
 * Exit code alone is not the test. `detectors.mjs` reads a line the gate prints when it refuses —
 * `/^\s*FAIL\s/` — as its evidence, so a gate that exits 0 while printing one of those is not green
 * for the purpose the probes put it to, and passing it here would seat the suite over exactly the
 * state this guards against.
 *
 * A precondition that runs per SUITE rather than per probe is sound only where the gate reads the
 * tree and nothing else: the harness restores every mutated file from git after each probe and
 * throws if the restore did not land, so the tree in front of the next probe is byte-identical to
 * the tree this measured. A gate that reads a database, a browser, the clock or the environment has
 * no such guarantee and must not be seated this way.
 */
export const requireGreenBeforeProbing = (suite, gates) => {
  for (const [command, args] of gates) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const failLines = output.split("\n").filter((line) => /^\s*FAIL\s/.test(line));

    if (result.status !== 0 || failLines.length > 0) {
      throw new Error(
        `CONTROL: ${suite} gate ${command} ${args.join(" ")} already fails at HEAD\n` +
          `  exit code ${result.status}, ${failLines.length} FAIL line(s) — a probe that goes red ` +
          `after this would prove nothing about its mutation.\n${output.slice(-1500)}`,
      );
    }
  }
};

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
