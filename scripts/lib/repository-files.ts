// THE POPULATION EVERY REPOSITORY-WIDE GATE READS: every file git would commit.
//
// Tracked, plus untracked-but-not-ignored. That is the set `git add .` stages and the set a reviewer
// sees in a diff, and it is the only population with one answer. LAUNCH-D139 and LAUNCH-D170 are the
// same defect measured on two instruments, from opposite sides:
//
//   - `verify:secrets` listed `git ls-files`, so it passed over none of a step's NEW files until they
//     were staged or committed. Measured at C2.1: 1187 files scanned while every new file was
//     untracked, which is the one moment a credential is cheapest to catch.
//   - the fixture-recipient gate walked the filesystem, so it read local scratch the repository will
//     never contain: a gitignored `test-artifacts/checklist/step-7b.mjs` failed it on every local run
//     and passed in CI, which is the shape where the gate's two runs disagree about what it covers.
//
// Neither question is about the filesystem. Both are about what a commit would carry, so both ask git.

import { execFileSync } from "node:child_process";

let repositoryRoot: string | undefined;

/** Memoized, and lazy so importing this module spawns nothing. */
const repositoryRootOf = (): string => {
  repositoryRoot ??= execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  return repositoryRoot;
};

/**
 * Repository-relative paths, sorted. NUL-separated, because a path may contain a newline and a
 * newline-separated listing would silently read one file as two.
 *
 * `-C <root>` rather than a `cwd` option: `git ls-files` confines itself to the current directory
 * when run from a subdirectory, which would make the population depend on where the caller stood.
 */
export const filesGitWouldCommit = (): string[] =>
  execFileSync(
    "git",
    ["-C", repositoryRootOf(), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
