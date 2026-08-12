// @vitest-environment node

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The product repository is PUBLIC. `CLAUDE.md`, `AGENTS.md` and `.claude/` are governance
// material that must never enter it or its history: they were purged from all history once
// already (DEC-0101), and they now live inside `docs/` — a separate private repository —
// reached through relative symlinks at the repository root (DEC-0159).
//
// That relocation is what makes this test necessary. The ignore rule was `/.claude/`, and a
// TRAILING SLASH MATCHES A DIRECTORY ONLY. The moment `.claude` became a symlink git
// reclassified it as a file, the rule stopped matching, and the path silently became
// untracked-and-committable in a public repo. Nothing failed at the moment it happened:
// no error, no lint warning, no test — just one line of `git status` that had to be read.
//
// A rule that stops matching when a directory becomes a symlink is precisely the kind of
// thing that gets rediscovered, so it is asserted here rather than left in a decision log.
// `git check-ignore` is the instrument because it is the same resolver `git add` and
// `git status` use — asserting on the text of `.gitignore` would prove only that a string is
// present, not that git agrees it applies to this path in its current form on disk.
//
// This holds in CI as well as locally, and deliberately so: with the trailing slash restored,
// `check-ignore` reports NOT IGNORED both when the path is a symlink (a developer checkout)
// and when it is absent entirely (a CI clone, where these paths do not exist because they are
// ignored). The correct slashless rule reports IGNORED in both states.

const SYMLINKED_DOC_LANE_PATHS = [".claude", "CLAUDE.md", "AGENTS.md"] as const;

type CheckIgnoreResult = {
  ignored: boolean;
  /** The pattern git matched, e.g. `/.claude` — empty when nothing matched. */
  pattern: string;
  source: string;
};

const checkIgnore = (path: string): CheckIgnoreResult => {
  const result = spawnSync("git", ["check-ignore", "-v", "--", path], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`git check-ignore could not be run for ${path}: ${result.error.message}`);
  }

  // 0 = ignored, 1 = not ignored. Anything else is git itself failing, and must not be read
  // as "not ignored" — that would turn a broken invocation into a silently passing test.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore exited ${result.status} for ${path}: ${result.stderr.trim()}`,
    );
  }

  if (result.status === 1) {
    return { ignored: false, pattern: "", source: "" };
  }

  // `-v` output is `<source>:<line>:<pattern>\t<path>`.
  const [describedRule = ""] = result.stdout.split("\t");
  const [source = "", line = "", ...patternParts] = describedRule.split(":");

  return { ignored: true, pattern: patternParts.join(":"), source: `${source}:${line}` };
};

describe("the product repo ignores the symlinked doc lane (DEC-0159)", () => {
  it("is running inside a git worktree, so no assertion below can pass by accident", () => {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, "git is unavailable or this is not a repository").toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });

  it.each(SYMLINKED_DOC_LANE_PATHS)("ignores %s", (path) => {
    const { ignored } = checkIgnore(path);

    expect(
      ignored,
      `${path} is NOT ignored by the product repository, so it can be committed into public ` +
        `history. It is a symlink into the private doc repo and must stay untracked here ` +
        `(DEC-0101, DEC-0159). If the rule for this path recently gained a trailing slash, ` +
        `that is the cause: a trailing slash matches directories only and stops matching a symlink.`,
    ).toBe(true);
  });

  it.each(SYMLINKED_DOC_LANE_PATHS)(
    "matches %s with a rule carrying no trailing slash",
    (path) => {
      const { pattern } = checkIgnore(path);

      // An unmatched path yields an empty pattern, and "" does not end in a slash — so without
      // this the assertion below would PASS in exactly the situation it is named for. Proven by
      // regression: with the trailing slash restored, this case went green while the behavioural
      // assertion above went red.
      expect(pattern, `No .gitignore rule matches ${path} at all.`).not.toBe("");

      expect(
        pattern.endsWith("/"),
        `The .gitignore rule matching ${path} is "${pattern}", which ends in a slash and ` +
          `therefore matches a DIRECTORY only. ${path} is a symlink, which git treats as a ` +
          `file, so this rule will stop applying and the path becomes committable in a public ` +
          `repository. Drop the trailing slash.`,
      ).toBe(false);
    },
  );

  it("still ignores docs/, whose rule may legitimately keep its trailing slash", () => {
    // `docs/` is a real directory, not a symlink, so `/docs/` is correct there. Asserted so a
    // future sweep that "consistently" removes trailing slashes does not read this file as
    // demanding it everywhere — the rule is about symlinks, not about slashes.
    //
    // The queried path keeps its trailing slash, and must. `check-ignore` classifies a path as a
    // directory by looking at the working tree, so a bare `docs` matches a directory-only rule
    // only where the directory exists on disk — true in a developer checkout, false in CI, where
    // `docs/` is absent precisely because it is ignored. The slash states the kind in the query
    // itself, so the assertion tests the rule rather than the checkout.
    expect(checkIgnore("docs/").ignored).toBe(true);
  });
});
