// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Include the shared v1 routes: platform operators reach cross-institution readers there too.
// Declare public handlers and MFA lifecycle exceptions separately, and classify each exported
// HTTP handler through its actual imported call rather than the presence of a guard import.

const OPERATIONAL_ROUTE_ROOTS = [
  "src/app/api/platform-ops",
  "src/app/api/admin",
  "src/app/api/v1",
] as const;
const GUARDED_IMPORTS: Record<string, readonly string[]> = {
  "@/server/auth/session": ["requireAuthenticatedSession", "requireSessionRole"],
  "@/server/auth/api-guard": ["withApiAuth", "withApiRole"],
  "@/server/user-domain/tenant-access": [
    "requireCurrentUserDomainContext",
    "requireCurrentUserInstitutionAccess",
  ],
  "@/server/user-profile/profile-collection-http": [
    "createCollectionEntry",
    "updateCollectionEntry",
    "deleteCollectionEntry",
  ],
  "@/server/user-profile/profile-file-http": [
    "avatarUploadUrl",
    "avatarRecord",
    "avatarDelete",
    "bannerUploadUrl",
    "bannerRecord",
    "bannerDelete",
    "resumeUploadUrl",
    "resumeRecord",
    "resumeDelete",
    "resumeSetVisibility",
    "certificationFileUploadUrl",
    "certificationFileRecord",
    "certificationFileDelete",
  ],
  "@/server/institution-workspace/institution-media-http": [
    "institutionMediaUploadUrl",
    "institutionMediaRecord",
    "institutionMediaDelete",
  ],
};
const EXCEPTIONS: Record<string, string> = {
  "src/app/api/v1/auth/identify/route.ts#POST": "Public sign-in account classification.",
  "src/app/api/v1/auth/register/route.ts#POST": "Public registration must precede authentication.",
  "src/app/api/v1/auth/register/resend/route.ts#POST": "Public email verification resend.",
  "src/app/api/v1/users/[username]/profile/route.ts#GET": "Public user profile.",
  "src/app/api/v1/competitions/route.ts#GET": "Public competition directory.",
  "src/app/api/v1/auth/mfa/challenge/route.ts#POST":
    "MFA lifecycle is guarded by withMfaRouteAuth.",
  "src/app/api/v1/auth/mfa/enroll/confirm/route.ts#POST":
    "MFA lifecycle is guarded by withMfaRouteAuth.",
  "src/app/api/v1/auth/mfa/recovery/route.ts#POST": "MFA lifecycle is guarded by withMfaRouteAuth.",
};

const analyzeHandlers = (
  text: string,
  file: string,
): { name: string; guarded: boolean; lifecycle: boolean }[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  const lifecycleBindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const entry of named.elements) {
      const imported = entry.propertyName?.text ?? entry.name.text;
      if (GUARDED_IMPORTS[statement.moduleSpecifier.text]?.includes(imported))
        bindings.add(entry.name.text);
      if (
        statement.moduleSpecifier.text === "@/server/auth/mfa/mfa-route-guard" &&
        imported === "withMfaRouteAuth"
      )
        lifecycleBindings.add(entry.name.text);
    }
  }
  const analyze = (node: ts.Node, name: string) => {
    let guarded = false;
    let lifecycle = false;
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        guarded ||= bindings.has(child.expression.text);
        lifecycle ||= lifecycleBindings.has(child.expression.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return { name, guarded, lifecycle };
  };
  return source.statements.flatMap((statement) => {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return [];
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(statement.name.text)
    )
      return [analyze(statement, statement.name.text)];
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) &&
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(declaration.name.text) &&
        declaration.initializer
          ? [analyze(declaration.initializer, declaration.name.text)]
          : [],
      );
    return [];
  });
};

const collectRouteFiles = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(path));
    } else if (entry.name === "route.ts") {
      found.push(path);
    }
  }
  return found;
};

describe("operational API routes reach the MFA choke point", () => {
  const routeFiles = OPERATIONAL_ROUTE_ROOTS.flatMap((root) => collectRouteFiles(root));

  it("finds every operational route tree, so an empty scan cannot pass silently", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(20);
  });

  it("covers the competition GET that exposed cross-institution data", () => {
    const file = "src/app/api/v1/competitions/[competitionId]/route.ts";
    expect(routeFiles).toContain(file);
    expect(analyzeHandlers(readFileSync(file, "utf8"), file)).toContainEqual({
      name: "GET",
      guarded: true,
      lifecycle: false,
    });
  });

  it("requires the secure session default before returning a session", () => {
    const source = ts.createSourceFile(
      "session.ts",
      readFileSync("src/server/auth/session.ts", "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (node) => ts.isIdentifier(node.name) && node.name.text === "requireAuthenticatedSession",
      );
    if (
      !declaration?.initializer ||
      !ts.isArrowFunction(declaration.initializer) ||
      !ts.isBlock(declaration.initializer.body)
    )
      throw new Error("Cannot classify requireAuthenticatedSession");
    const statements = declaration.initializer.body.statements;
    const gate = statements.findIndex(
      (statement) =>
        ts.isIfStatement(statement) &&
        statement.getText(source).includes("assertMfaSatisfiedForOperationalSession(session)"),
    );
    const returned = statements.findIndex(ts.isReturnStatement);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(returned).toBeGreaterThan(gate);
  });

  it.each(Object.entries(EXCEPTIONS))("%s is a real declared exception: %s", (key, reason) => {
    const [file, method] = key.split("#");
    if (!file || !method) throw new Error("Cannot classify exception");
    expect(reason.length).toBeGreaterThan(0);
    expect(routeFiles).toContain(file);
    const handler = analyzeHandlers(readFileSync(file, "utf8"), file).find(
      (item) => item.name === method,
    );
    expect(handler).toBeDefined();
    if (key.includes("/auth/mfa/")) expect(handler?.lifecycle).toBe(true);
  });

  it("rejects a guard import without a guard call on inline source", () => {
    expect(
      analyzeHandlers(
        'import { requireAuthenticatedSession } from "@/server/auth/session"; export async function GET() { return loadData(); }',
        "inline.ts",
      ),
    ).toEqual([{ name: "GET", guarded: false, lifecycle: false }]);
  });

  it.each(routeFiles)("%s reaches an MFA gate or a declared exception", (file) => {
    const source = readFileSync(file, "utf8");
    const handlers = analyzeHandlers(source, file);
    expect(handlers.length, `${file} has no classifiable exported HTTP handler`).toBeGreaterThan(0);
    for (const handler of handlers) {
      if (Object.hasOwn(EXCEPTIONS, `${file}#${handler.name}`)) continue;
      expect(
        handler.guarded,
        `${file}#${handler.name} must call an imported MFA-enforcing guard or a declared guarded HTTP helper`,
      ).toBe(true);
    }
  });
});
