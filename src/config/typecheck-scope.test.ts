// @vitest-environment node

// What the typecheck GATE looks at. A gate that reports failures unrelated to the change under test
// stops being read, and then stops being a gate — so what it does and does not compile is pinned
// here rather than left to whoever edits tsconfig.json next.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tsconfig = JSON.parse(readFileSync(resolve(process.cwd(), "tsconfig.json"), "utf8")) as {
  include: string[];
  exclude: string[];
};

describe("tsconfig include", () => {
  // NOT IN THE FORMAT GATE, and this is the reason. `next build` rewrites this file — it appends
  // its own `include` entries and reflows the JSON — so requiring Prettier's shape here would make
  // `npm run format:check` fail after every local build. A gate that goes red for a reason
  // unrelated to the change under test is the defect this whole step exists to remove. The file is
  // committed in the shape the build leaves it, and its MEANING is pinned by the assertions below
  // rather than by its formatting.

  // THE DEFECT. `.next/dev/types` is rewritten by the dev server every time a route changes, so a
  // read that lands mid-write makes `npm run typecheck` report an error in generated output. The
  // build-produced `.next/types` carries the same three files with the same content — only the
  // relative import depth differs — so dropping the dev copy costs no coverage.
  //
  // EXCLUDED, NOT MERELY ABSENT FROM `include`. Next.js manages this file: it rewrote the entry
  // back into `include` on the next `npm run build` after it was first removed, and this test is
  // what caught it. `exclude` filters `include`, so the directory stays out even when the
  // framework puts it back.
  it("does not compile the dev server's own generated types", () => {
    expect(tsconfig.exclude).toContain(".next/dev");
  });

  it("still compiles the build-produced route types", () => {
    expect(tsconfig.include).toContain(".next/types/**/*.ts");
  });

  // The old `**/*.ts` looked as though it swept `.next`, which is why the debt was filed against it.
  // It never did — TypeScript's globs skip dot-directories — and the explicit roots say so plainly.
  it("names its roots explicitly rather than globbing the repository", () => {
    expect(tsconfig.include).not.toContain("**/*.ts");
    expect(tsconfig.include).toEqual(
      expect.arrayContaining([
        "src/**/*.ts",
        "src/**/*.tsx",
        "scripts/**/*.ts",
        "scripts/**/*.mts",
      ]),
    );
  });
});
