/**
 * Proves one edit of a committed hook script: the script is copied into a throwaway git repository,
 * one element is edited, the caller observes the edited copy, and the copy is put back through git
 * with a clean `git diff` asserted. It refuses a script that is not committed and a pattern that does
 * not match exactly one line, so the edit is shown to have applied and to be the one that was claimed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MutationTarget {
  pathInRepo: string;
  /** The script holds a python program in a heredoc, which the compile check must parse too. */
  pythonHeredoc?: boolean;
}

export interface MutationSite {
  /** The docs checkout that holds the committed script. */
  repoRoot: string;
  /** A folder the proof may create its throwaway repositories in. */
  scratchFolder: string;
}

const GIT_IDENTITY = ["-c", "user.name=Deny Proof Test", "-c", "user.email=test@example.invalid"];
const PYTHON_HEREDOC = /<<'PY'\n([\s\S]*?)\nPY\n/;

export const gitIn = (cwd: string, args: string[]): void => {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};

// `bash -n` reads the bash lines only, so a script whose logic is a python heredoc has that body
// parsed on its own.
export const pythonBodyParses = (scriptText: string, scratchFile: string): boolean => {
  const body = PYTHON_HEREDOC.exec(scriptText)?.[1];
  if (body === undefined) return false;
  writeFileSync(scratchFile, body);
  const parsed = spawnSync("python3", [
    "-c",
    "import ast, sys; ast.parse(open(sys.argv[1]).read())",
    scratchFile,
  ]);
  return parsed.status === 0;
};

const refuseUncommitted = (repoRoot: string, pathInRepo: string): void => {
  const tracked = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "--error-unmatch", "--", pathInRepo],
    {
      encoding: "utf8",
    },
  );
  if (tracked.status !== 0) throw new Error(`${pathInRepo} is not tracked in the docs repository`);
  const committed = spawnSync(
    "git",
    ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", pathInRepo],
    {
      encoding: "utf8",
    },
  );
  if (committed.status !== 0) throw new Error(`commit ${pathInRepo} before a mutation proof`);
};

export const proveMutation = async <Observed>(
  site: MutationSite,
  target: MutationTarget,
  name: string,
  pattern: RegExp,
  replacement: string,
  observe: (file: string) => Observed | Promise<Observed>,
): Promise<{ applied: boolean; compiles: boolean; observed: Observed; restoredFile: string }> => {
  refuseUncommitted(site.repoRoot, target.pathInRepo);
  const repo = mkdtempSync(join(site.scratchFolder, "mutation-"));
  const file = join(repo, target.pathInRepo);
  mkdirSync(dirname(file), { recursive: true });
  const original = readFileSync(join(site.repoRoot, target.pathInRepo), "utf8");
  writeFileSync(file, original);
  gitIn(repo, ["init", "-q"]);
  gitIn(repo, ["add", target.pathInRepo]);
  gitIn(repo, ["commit", "-q", "-m", "the script as committed"]);
  const matches = original.match(new RegExp(pattern.source, "gm")) ?? [];
  if (matches.length !== 1)
    throw new Error(`the mutation ${name} matches ${matches.length} lines, not 1`);
  let observed: { applied: boolean; compiles: boolean; observed: Observed };
  try {
    writeFileSync(
      file,
      original.replace(pattern, () => replacement),
    );
    const diff = spawnSync("git", ["diff", "--quiet", "--", target.pathInRepo], { cwd: repo });
    const mutatedText = readFileSync(file, "utf8");
    const bashCompiles = spawnSync("bash", ["-n", file]).status === 0;
    const pythonCompiles =
      target.pythonHeredoc !== true || pythonBodyParses(mutatedText, join(repo, "body.py"));
    observed = {
      applied: diff.status === 1,
      compiles: bashCompiles && pythonCompiles,
      observed: await observe(file),
    };
  } finally {
    gitIn(repo, ["checkout", "--", target.pathInRepo]);
    const restored = spawnSync("git", ["diff", "--quiet", "--", target.pathInRepo], { cwd: repo });
    if (restored.status !== 0)
      throw new Error(`the copy of ${target.pathInRepo} was not restored from git`);
  }
  return { ...observed, restoredFile: file };
};
