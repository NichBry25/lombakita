// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWLIST: Record<string, string> = {
  "src/server/auth/session.ts": "Role gates must refuse a wrong role before disclosing MFA state.",
  "src/server/auth/mfa/mfa-route-guard.ts":
    "MFA lifecycle handlers must run before MFA is satisfied.",
  "src/server/auth/session.test.ts":
    "Regression tests exercise the explicit MFA lifecycle exception.",
};

const enumerateSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? enumerateSourceFiles(file)
      : /\.[cm]?[jt]sx?$/.test(file)
        ? [file]
        : [];
  });

const optOutLines = (text: string, file: string): number[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "allowUnsatisfiedMfa" &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

const violations = (text: string, file: string): number[] =>
  Object.hasOwn(ALLOWLIST, file) ? [] : optOutLines(text, file);

describe("unsatisfied MFA opt-out enumeration", () => {
  const files = enumerateSourceFiles("src");
  it("enumerates a nonempty source population", () => expect(files.length).toBeGreaterThan(0));
  it("permits every literal opt-out only in the explicit allowlist", () => {
    expect(
      files.flatMap((file) =>
        violations(readFileSync(file, "utf8"), file).map((line) => `${file}:${line}`),
      ),
    ).toEqual([]);
  });
  it.each(Object.entries(ALLOWLIST))("%s contains its exception: %s", (file, reason) => {
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(files).toContain(file);
    expect(optOutLines(readFileSync(file, "utf8"), file).length).toBeGreaterThan(0);
  });
  it.each([
    "requireAuthenticatedSession({ allowUnsatisfiedMfa: true });",
    "const options = { 'allowUnsatisfiedMfa': true };",
  ])("rejects an inline exception outside the allowlist: %s", (source) => {
    expect(violations(source, "src/app/api/v1/new/route.ts")).toEqual([1]);
  });
  it("ignores comments and string fixtures rather than counting them as options", () => {
    expect(
      optOutLines(
        '// allowUnsatisfiedMfa: true\nconst text = "allowUnsatisfiedMfa: true";',
        "inline.ts",
      ),
    ).toEqual([]);
  });
});
