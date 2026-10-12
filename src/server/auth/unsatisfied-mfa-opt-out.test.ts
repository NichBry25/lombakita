// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/server/auth/session.ts": {
    count: 1,
    reason: "Role gates must refuse a wrong role before disclosing MFA state.",
  },
  "src/server/auth/mfa/mfa-route-guard.ts": {
    count: 1,
    reason: "MFA lifecycle handlers must run before MFA is satisfied.",
  },
  "src/server/auth/session.test.ts": {
    count: 1,
    reason: "Regression tests exercise the explicit MFA lifecycle exception.",
  },
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

const unwrapInitializer = (expression: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
};

const isOptOutProperty = (name: ts.PropertyName): boolean => {
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteral(name.expression) && name.expression.text === "allowUnsatisfiedMfa";
  }
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "allowUnsatisfiedMfa";
};

const optOutLines = (text: string, file: string): number[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      isOptOutProperty(node.name) &&
      unwrapInitializer(node.initializer).kind === ts.SyntaxKind.TrueKeyword
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

const violations = (text: string, file: string): number[] =>
  optOutLines(text, file).slice(ALLOWLIST[file]?.count ?? 0);

describe("unsatisfied MFA opt-out enumeration", () => {
  const files = enumerateSourceFiles("src");
  it("enumerates a nonempty source population", () => expect(files.length).toBeGreaterThan(0));
  it("permits opt-outs only within the exact per-file allowance", () => {
    expect(
      files.flatMap((file) =>
        violations(readFileSync(file, "utf8"), file).map((line) => `${file}:${line}`),
      ),
    ).toEqual([]);
  });
  it.each(Object.entries(ALLOWLIST))(
    "%s contains exactly its counted exceptions",
    (file, { count, reason }) => {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(files).toContain(file);
      expect(optOutLines(readFileSync(file, "utf8"), file)).toHaveLength(count);
    },
  );
  it.each([
    "requireAuthenticatedSession({ allowUnsatisfiedMfa: true });",
    "const options = { 'allowUnsatisfiedMfa': true };",
    "const options = { allowUnsatisfiedMfa: (true) };",
    "const options = { allowUnsatisfiedMfa: true as const };",
    "const options = { ['allowUnsatisfiedMfa']: true };",
    "const options = { allowUnsatisfiedMfa: true satisfies boolean };",
    "const options = { allowUnsatisfiedMfa: true! };",
    "const options = { allowUnsatisfiedMfa: ((true as const) satisfies boolean)! };",
  ])("rejects an inline exception outside the allowlist: %s", (source) => {
    expect(violations(source, "src/app/api/v1/new/route.ts")).toEqual([1]);
  });
  it.each(Object.keys(ALLOWLIST))("rejects a second exception in %s", (file) => {
    const source =
      "requireAuthenticatedSession({ allowUnsatisfiedMfa: true });\n" +
      "requireAuthenticatedSession({ allowUnsatisfiedMfa: true });";
    expect(violations(source, file)).toEqual([2]);
  });
  it("does not count wrapped false values or dynamic computed keys as opt-outs", () => {
    expect(
      optOutLines(
        "const options = { allowUnsatisfiedMfa: ((false as const) satisfies boolean)!, [key]: true };",
        "inline.ts",
      ),
    ).toEqual([]);
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
