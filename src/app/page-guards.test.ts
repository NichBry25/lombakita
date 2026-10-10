import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SECTIONS = ["src/app/admin", "src/app/finance"];
const CLIENT_PAGES: Record<string, string> = {
  "src/app/admin/institutions/page.tsx": "Client queue reads through role-guarded APIs.",
  "src/app/admin/verification/page.tsx": "Client document review reads through role-guarded APIs.",
  "src/app/admin/recruiter-verification/page.tsx":
    "Client recruiter queue reads through role-guarded APIs.",
};

const enumerateFiles = (directory: string): string[] =>
  readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? enumerateFiles(path) : [path];
  });

const parseSource = (source: string, path: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const beginsWithClientDirective = (source: ts.SourceFile): boolean => {
  const first = source.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
};

const callbackPathFor = (path: string): string => {
  const segments = relative("src/app", dirname(path)).split("/");
  const dynamic = segments.findIndex((segment) => segment.startsWith("["));
  return "/" + (dynamic === -1 ? segments : segments.slice(0, dynamic)).join("/");
};

const analyzeServerPage = (text: string, path: string, role: string): string[] => {
  const source = parseSource(text, path);
  const page = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
  if (!page || !ts.isFunctionDeclaration(page) || !page.body) {
    return ["default page export cannot be classified"];
  }
  const first = page.body.statements[0];
  if (
    !first ||
    !ts.isExpressionStatement(first) ||
    !ts.isAwaitExpression(first.expression) ||
    !ts.isCallExpression(first.expression.expression)
  ) {
    return ["first statement must await requireRolePage before any reader"];
  }
  const call = first.expression.expression;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "requireRolePage") {
    return ["first statement must await requireRolePage before any reader"];
  }
  const guardImport = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/server/auth/page-guard" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "requireRolePage" && !element.propertyName,
      ),
  );
  const [roleArgument, options] = call.arguments;
  const errors: string[] = [];
  if (!guardImport) errors.push("guard must import the real requireRolePage");
  if (!roleArgument || !ts.isStringLiteral(roleArgument) || roleArgument.text !== role) {
    errors.push("guard role must match the nearest guarded layout");
  }
  const callback =
    options && ts.isObjectLiteralExpression(options)
      ? options.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === "callbackPath",
        )
      : undefined;
  if (
    !callback ||
    !ts.isPropertyAssignment(callback) ||
    !ts.isStringLiteral(callback.initializer) ||
    callback.initializer.text !== callbackPathFor(path)
  ) {
    errors.push(
      "callbackPath must be the page's string literal URL or its static dynamic-page parent",
    );
  }
  return errors;
};

const files = SECTIONS.flatMap(enumerateFiles);
const layouts = new Map<string, string>();
for (const path of files.filter((path) => path.endsWith("/layout.tsx"))) {
  const source = parseSource(readFileSync(join(ROOT, path), "utf8"), path);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "requireRolePage"
    ) {
      const role = node.arguments[0];
      if (!role || !ts.isStringLiteral(role) || layouts.has(dirname(path))) {
        throw new Error(`Cannot classify layout role: ${path}`);
      }
      layouts.set(dirname(path), role.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const pages = files.filter((path) => path.endsWith("/page.tsx"));
const nearestLayoutRole = (path: string): string => {
  let directory = dirname(path);
  while (directory.startsWith("src/app")) {
    const role = layouts.get(directory);
    if (role) return role;
    directory = dirname(directory);
  }
  throw new Error(`No guarded layout for ${path}`);
};

describe("operator page guard enumeration", () => {
  it("enumerates a nonempty page and guarded-layout population", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(layouts.size).toBeGreaterThan(0);
  });

  it.each(Object.entries(CLIENT_PAGES))("%s really begins with use client: %s", (path) => {
    expect(pages).toContain(path);
    expect(
      beginsWithClientDirective(parseSource(readFileSync(join(ROOT, path), "utf8"), path)),
    ).toBe(true);
  });

  it.each(pages)("%s guards before every reader or is explicitly client-allowlisted", (path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    const source = parseSource(text, path);
    if (Object.hasOwn(CLIENT_PAGES, path)) {
      expect(beginsWithClientDirective(source)).toBe(true);
      return;
    }
    expect(beginsWithClientDirective(source), "client pages require an explicit reason").toBe(
      false,
    );
    expect(analyzeServerPage(text, path, nearestLayoutRole(path))).toEqual([]);
  });

  it.each([
    "export default async function Page() { await loadPayments(); }",
    'import { requireRolePage } from "@/server/auth/page-guard"; export default async function Page() { await loadPayments(); await requireRolePage("finance_ops", { callbackPath: "/finance/payments" }); }',
  ])("reports missing and late guards on inline source: %s", (source) => {
    expect(analyzeServerPage(source, "src/app/finance/payments/page.tsx", "finance_ops")).toContain(
      "first statement must await requireRolePage before any reader",
    );
  });
});
