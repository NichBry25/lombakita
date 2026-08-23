// What the FORMAT gate looks at, and what it deliberately does not.
//
// The gate became a merge blocker in the same change that narrowed it, and a silent narrowing is
// how a gate ends up covering less than everyone believes it does. So the exclusions are declared
// here with the reason each one is excluded, and pinned — both that the gate still lists them
// nowhere, and that it still covers what it is for.
//
// The five below were REMOVED rather than kept because Prettier exits non-zero on
// `No files matching the pattern`: listing a path that is absent from a clean checkout means the
// gate can never pass, which is exactly what it did on its first CI run. All five are gitignored
// (README.md at .gitignore:61, the four .env examples alongside it) and all five were tracked once,
// so they are present on a developer's disk and absent everywhere the gate actually runs.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Path, and why the format gate cannot list it. */
const EXCLUDED_FROM_THE_GATE = {
  "README.md": "gitignored, so it exists on a developer's disk and nowhere the gate runs",
  ".env.example": "gitignored and no longer on disk",
  ".env.preview.example": "gitignored and no longer on disk",
  ".env.production.example": "gitignored and no longer on disk",
  ".env.worker.example": "gitignored and no longer on disk",
  "tsconfig.json": "`next build` rewrites and reflows it, so the gate would go red after any build",
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

  // `format` and `format:check` must look at the same set, or `npm run format` leaves files the
  // gate then fails on, or cleans files the gate never checks.
  it("writes exactly what it checks", () => {
    const patternsOf = (script: string) => script.replace(/^prettier[^"]*/, "").trim();
    expect(patternsOf(formatWrite)).toBe(patternsOf(formatCheck));
  });
});
