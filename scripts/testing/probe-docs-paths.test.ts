// Every docs path a probe names must be addressable by git inside the docs repository.
//
// The probe harness reaches docs files through `git -C docs`, and git refuses a path that passes
// through a symbolic link. Several docs folders are compatibility links to their real folders, so
// a path spelled through one of them reads fine with fs and is refused by git. A probe holding such
// a path only fails when the nightly suite runs it; this test fails the same breakage on the PR.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROBES_DIR = resolve(__dirname, "probes");
const DOCS_DIR = resolve(__dirname, "..", "..", "docs");
const DOCS_REPO_PRESENT = existsSync(join(DOCS_DIR, ".git"));

// Whole string literals only: a path inside a comment or a longer sentence is not an input to git.
const DOCS_FILE_LITERAL = /(["'])(docs\/[^"'\n]*?\.(?:md|yaml|yml|json))\1/g;

const probeModules = readdirSync(PROBES_DIR).filter((name) => name.endsWith(".mjs"));

const docsPathsNamedBy = (probeModule: string): string[] => {
  const source = readFileSync(join(PROBES_DIR, probeModule), "utf8");
  const literals = [...source.matchAll(DOCS_FILE_LITERAL)].map((match) => match[2] ?? "");
  return [...new Set(literals)];
};

const gitCanAddress = (docsRelativePath: string): boolean => {
  try {
    execFileSync("git", ["-C", DOCS_DIR, "ls-files", "--error-unmatch", "--", docsRelativePath], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

if (!DOCS_REPO_PRESENT) {
  console.warn(
    "probe-docs-paths: SKIPPED. docs/.git is absent, so git cannot be asked whether it tracks the " +
      "docs paths the probes name.",
  );
}

describe.skipIf(!DOCS_REPO_PRESENT)("probes name docs files that git can address", () => {
  it("finds probe modules to check", () => {
    expect(probeModules.length).toBeGreaterThan(0);
  });

  it("finds at least one docs path across the probes, so an empty extraction cannot pass", () => {
    const total = probeModules.flatMap(docsPathsNamedBy).length;
    expect(total).toBeGreaterThan(0);
  });

  for (const probeModule of probeModules) {
    for (const path of docsPathsNamedBy(probeModule)) {
      it(`${probeModule}: ${path}`, () => {
        const docsRelativePath = path.slice("docs/".length);
        expect(
          gitCanAddress(docsRelativePath),
          `${probeModule} names ${path}, which git -C docs cannot address (untracked, or reached through a symbolic link)`,
        ).toBe(true);
      });
    }
  }
});
