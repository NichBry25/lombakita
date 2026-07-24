import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAW_DISPLAY_FIELD_NAMES = new Set([
  "appRole",
  "category",
  "documentType",
  "eventType",
  "invitedRole",
  "membershipRole",
  "mode",
  "platform",
  "registrationStatus",
  "role",
  "savedStatus",
  "status",
  "tier",
  "verificationStatus",
]);

const listTsxFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(entryPath);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [entryPath];
  });

const getReferencedName = (node: ts.Expression): string | null => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
};

const directlyExposesRawDisplayValue = (expression: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(expression)) {
    return directlyExposesRawDisplayValue(expression.expression);
  }

  if (ts.isCallExpression(expression) || ts.isElementAccessExpression(expression)) {
    return false;
  }

  const referencedName = getReferencedName(expression);
  if (referencedName) return RAW_DISPLAY_FIELD_NAMES.has(referencedName);

  if (ts.isConditionalExpression(expression)) {
    return (
      directlyExposesRawDisplayValue(expression.whenTrue) ||
      directlyExposesRawDisplayValue(expression.whenFalse)
    );
  }

  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => directlyExposesRawDisplayValue(span.expression));
  }

  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return directlyExposesRawDisplayValue(expression.right);
    }

    return (
      directlyExposesRawDisplayValue(expression.left) ||
      directlyExposesRawDisplayValue(expression.right)
    );
  }

  return false;
};

const findRawDisplayViolations = (filePath: string): string[] => {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  const report = (node: ts.Node) => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const relativePath = path.relative(process.cwd(), filePath);
    violations.push(`${relativePath}:${location.line + 1} ${node.getText(sourceFile)}`);
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression &&
      directlyExposesRawDisplayValue(node.expression)
    ) {
      report(node);
    }

    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sourceFile) === "value" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      directlyExposesRawDisplayValue(node.initializer.expression)
    ) {
      const openingElement = node.parent.parent;
      if (
        (ts.isJsxOpeningElement(openingElement) || ts.isJsxSelfClosingElement(openingElement)) &&
        openingElement.tagName.getText(sourceFile) === "input"
      ) {
        report(node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
};

describe("UI capitalization contract", () => {
  it("does not render storage tokens directly on any page or shared component", () => {
    const projectRoot = process.cwd();
    const files = [
      ...listTsxFiles(path.join(projectRoot, "src/app")),
      ...listTsxFiles(path.join(projectRoot, "src/components")),
    ];
    const violations = files.flatMap(findRawDisplayViolations);

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
