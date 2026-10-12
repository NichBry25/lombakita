import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { enumerateAuthSourceFiles } from "@/server/auth/unsatisfied-mfa-opt-out";

const SESSION_PAGES: Record<string, string> = {
  "src/app/[username]/page.tsx": "Public profile reads the viewer session for the owner redirect.",
  "src/app/competitions/[institutionSlug]/[slug]/page.tsx":
    "Public competition detail reads the optional viewer session for candidate affordances.",
  "src/app/institution/[institutionSlug]/page.tsx":
    "Public institution hub reads membership before entering its existing recruiter guard.",
  "src/app/inbox/page.tsx": "Existing user inbox session gate is outside the four pages in P1d-2.",
  "src/app/profile/page.tsx":
    "Existing owner-profile session gate is outside the four pages in P1d-2.",
  "src/app/profile/edit/page.tsx":
    "Existing owner-profile edit session gate is outside the four pages in P1d-2.",
  "src/app/protected/page.tsx":
    "Development diagnostic asserts its session and refuses production rendering.",
};

const sessionCallLines = (text: string, file: string): number[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set(["getCurrentSession"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const entry of bindings.elements) {
      if ((entry.propertyName ?? entry.name).text === "getCurrentSession")
        names.add(entry.name.text);
    }
  }
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (name && names.has(name))
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

const pages = enumerateAuthSourceFiles("src/app").filter((file) => /\/page\.tsx$/.test(file));

describe("direct page session enumeration", () => {
  it("enumerates a nonempty page population", () => expect(pages.length).toBeGreaterThan(0));
  it("permits direct session calls only in explicitly reasoned pages", () => {
    expect(
      pages.filter(
        (file) =>
          sessionCallLines(readFileSync(file, "utf8"), file).length > 0 &&
          !Object.hasOwn(SESSION_PAGES, file),
      ),
    ).toEqual([]);
  });
  it.each(Object.entries(SESSION_PAGES))(
    "%s has a live call and a nonempty reason",
    (file, reason) => {
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(pages).toContain(file);
      expect(sessionCallLines(readFileSync(file, "utf8"), file).length).toBeGreaterThan(0);
    },
  );
  it.each([
    "export default async function Page() { await getCurrentSession(); }",
    'import { getCurrentSession as session } from "@/server/auth/session"; export default async function Page() { await session(); }',
    'import * as auth from "@/server/auth/session"; export default async function Page() { await auth.getCurrentSession(); }',
  ])("detects an unlisted direct call: %s", (source) => {
    expect(sessionCallLines(source, "src/app/new/page.tsx")).toEqual([1]);
  });
});
