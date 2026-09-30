import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `form-hint` was a className with no CSS rule anywhere — globals.css defines `.form-help` and
// `.pf-media-hint` and never defined `.form-hint` — so every use of it rendered as unstyled body
// text. The token is retired: a className carrying it means a control has lost the class that
// gives it its shape, which is a defect no other instrument reports.
const RETIRED_TOKEN = "form-hint";

const listSourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    if (entry.name.includes(".test.")) return [];
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    return [entryPath];
  });

const classNameValues = (source: string): string[] => {
  const values: string[] = [];
  const attribute = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(source)) !== null) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return values;
};

const findRetiredTokenViolations = (relativePath: string, source: string): string[] =>
  classNameValues(source)
    .filter((value) => value.split(/[\s"'`]+/).includes(RETIRED_TOKEN))
    .map((value) => `${relativePath} className="${value}"`);

describe("the form-hint token", () => {
  it("detects the token in a className value", () => {
    const violations = findRetiredTokenViolations(
      "src/example.tsx",
      `<span className="${RETIRED_TOKEN}">x</span>`,
    );

    expect(violations).toEqual([`src/example.tsx className="${RETIRED_TOKEN}"`]);
  });

  it("appears in no className in src", () => {
    const projectRoot = process.cwd();
    const files = listSourceFiles(path.join(projectRoot, "src"));
    const violations = files.flatMap((filePath) => {
      const relativePath = path.relative(projectRoot, filePath);
      return findRetiredTokenViolations(relativePath, fs.readFileSync(filePath, "utf8"));
    });

    // A scan that read no files reports the same clean result as a scan that read them all.
    expect(files.length, "no source files were scanned").toBeGreaterThan(0);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
