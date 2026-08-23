// What the FORMAT gate looks at, and what it deliberately does not.
//
// The gate became a merge blocker in the same change that narrowed it, and a silent narrowing is
// how a gate ends up covering less than everyone believes it does. So the exclusions are declared
// here with the reason each one is excluded, and pinned — both that the gate still lists them
// nowhere, and that it still covers what it is for.
//
// The five below were REMOVED rather than kept, and they are NOT one case. Four of them no longer
// exist anywhere — not in the checkout, not on the developer's disk, not in the working tree — so
// there is nothing for the gate to read. README.md exists locally and cannot be committed at all
// under DEC-0101, so it is absent from every environment the gate runs in.
//
// A glob does not rescue either case, and this was measured rather than assumed: Prettier exits 2
// on `.env*.example` with the same "No files matching the pattern were found" it gives an explicit
// path. Zero matches is the error, not the spelling of the pattern. So the choice is not
// "exclusion versus glob" — it is "exclusion versus a gate that can never pass", and the second is
// what shipped on the first CI run.
//
// This is a reduction in the gate's DECLARED subject and not in what it covers: no environment the
// gate runs in contains any of these files. The "genuinely absent" test below is what keeps that
// true — the day one of them comes back as a tracked file, the reason for its entry has gone and
// the test goes red until the entry does.

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Path, and why the format gate cannot list it. One reason per path, not one reason for all. */
const EXCLUDED_FROM_THE_GATE = {
  "README.md":
    "gitignored under DEC-0101 and never committed, so it is on this disk and in no checkout",
  ".env.example": "deleted from the repository; the file does not exist in any environment",
  ".env.preview.example": "deleted from the repository; the file does not exist in any environment",
  ".env.production.example":
    "deleted from the repository; the file does not exist in any environment",
  ".env.worker.example": "deleted from the repository; the file does not exist in any environment",
  "tsconfig.json": "`next build` rewrites and reflows it, so the gate would go red after any build",
};

/** The four that are gone entirely, as opposed to the one that merely cannot be committed. */
const DELETED_FROM_THE_REPOSITORY = [
  ".env.example",
  ".env.preview.example",
  ".env.production.example",
  ".env.worker.example",
];

/** The wildcard patterns in a Prettier invocation, unquoted. */
const globPatternsIn = (script: string): string[] =>
  script
    .split(/\s+/)
    .filter((token) => token.includes("*"))
    .map((token) => token.replace(/^"|"$/g, ""));

/**
 * How many files a `dir/**\/*.{a,b}` pattern actually matches.
 *
 * Only the two shapes the gate uses are understood, and an unrecognised one throws rather than
 * returning zero — a matcher that silently answers "none" to a pattern it cannot read would fail
 * the gate for the wrong reason, which is the failure class this whole file is about.
 */
const filesMatching = (pattern: string): number => {
  const match = /^(.*?)\/(?:\*\*\/)?\*\.\{([^}]+)\}$/.exec(pattern);
  if (!match) throw new Error(`this test cannot read the pattern ${pattern}`);

  const [, directory, extensionList] = match;
  const extensions = extensionList!.split(",").map((e) => `.${e}`);
  const root = resolve(process.cwd(), directory!);
  if (!existsSync(root)) return 0;

  const recursive = pattern.includes("**");
  const entries = readdirSync(root, { recursive, withFileTypes: true });
  return entries.filter(
    (entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)),
  ).length;
};

const isIgnoredOrAbsent = (path: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: process.cwd(), stdio: "ignore" });
    return true;
  } catch {
    // `check-ignore` exits 1 when the path is NOT ignored, which for a tracked file means the gate
    // could legitimately list it — so the claim in the table would be wrong.
    return false;
  }
};

describe("format gate scope", () => {
  const formatCheck = packageJson.scripts["format:check"] ?? "";
  const formatWrite = packageJson.scripts["format"] ?? "";

  it.each(Object.entries(EXCLUDED_FROM_THE_GATE))("does not list %s, because it is %s", (path) => {
    expect(formatCheck).not.toContain(path);
    expect(formatWrite).not.toContain(path);
  });

  // The claim the exclusions rest on. If one of these ever becomes a tracked, present file, the
  // reason for excluding it has gone and the entry should go with it.
  it.each(Object.keys(EXCLUDED_FROM_THE_GATE).filter((p) => p !== "tsconfig.json"))(
    "%s is genuinely absent from a clean checkout",
    (path) => {
      expect(isIgnoredOrAbsent(path), `${path} is tracked — the gate could list it`).toBe(true);
    },
  );

  it("still covers the application source and the workflows", () => {
    expect(formatCheck).toContain("src/**/*.{ts,tsx,css}");
    expect(formatCheck).toContain(".github/workflows/*.{yml,yaml}");
  });

  // The apparatus that gates the repository was itself ungated: every line this step wrote landed
  // in scripts/testing/, the one directory the format gate could not see.
  it("covers the tooling directory, which is where the gates themselves live", () => {
    expect(formatCheck).toContain("scripts/**/*.{ts,mjs}");
  });

  // Zero matches is Prettier's error condition, so a pattern in the gate that matches nothing makes
  // the gate permanently red — measured in the block at the bottom of this file. Checked per
  // pattern, because the failure arrives when a directory is emptied, not when the pattern is
  // written. Counted from the filesystem rather than by running Prettier: asking the formatter adds
  // fifteen seconds to the suite to answer a question about which files exist.
  it.each(globPatternsIn(formatCheck))("%s matches at least one file", (pattern) => {
    expect(
      filesMatching(pattern),
      `${pattern} matches nothing, so the gate can never pass`,
    ).toBeGreaterThan(0);
  });

  // `format` and `format:check` must look at the same set, or `npm run format` leaves files the
  // gate then fails on, or cleans files the gate never checks.
  it("writes exactly what it checks", () => {
    const patternsOf = (script: string) => script.replace(/^prettier[^"]*/, "").trim();
    expect(patternsOf(formatWrite)).toBe(patternsOf(formatCheck));
  });
});

/**
 * The measurement the exclusions rest on, pinned so it is re-checked rather than remembered.
 *
 * The proposed alternative to excluding a missing path is a glob. It does not work: Prettier treats
 * zero matches as an error whether the pattern is a literal path or a wildcard. If a future Prettier
 * changes that, this test goes red and every `.env*.example` entry above can become a glob.
 */
describe("what Prettier does with a pattern that matches nothing", () => {
  const prettier = resolve(process.cwd(), "node_modules/.bin/prettier");

  const checkIn = (directory: string, patterns: string[]) =>
    spawnSync(prettier, ["--ignore-unknown", "--check", ...patterns], {
      cwd: directory,
      encoding: "utf8",
    });

  it("errors on a wildcard that matches nothing, exactly as on a literal path", () => {
    const directory = mkdtempSync(join(tmpdir(), "format-scope-"));
    try {
      writeFileSync(join(directory, "kept.ts"), "const a = 1;\n");

      const wildcard = checkIn(directory, ["kept.ts", ".env*.example"]);
      const literal = checkIn(directory, ["kept.ts", ".env.example"]);

      expect(wildcard.status).not.toBe(0);
      expect(literal.status).not.toBe(0);
      expect(wildcard.stderr).toContain("No files matching the pattern");
      expect(literal.stderr).toContain("No files matching the pattern");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes once the wildcard matches at least one file", () => {
    const directory = mkdtempSync(join(tmpdir(), "format-scope-"));
    try {
      writeFileSync(join(directory, "kept.ts"), "const a = 1;\n");
      writeFileSync(join(directory, ".env.preview.example"), "A=1\n");

      expect(checkIn(directory, ["kept.ts", ".env*.example"]).status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
