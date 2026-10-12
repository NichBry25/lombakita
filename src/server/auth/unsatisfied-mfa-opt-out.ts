import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import ts from "typescript";

export const MFA_OPT_OUT_NAME = "allowUnsatisfiedMfa";
export const AUTH_SOURCE_POPULATION = {
  command: "git",
  arguments: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  extensions: /\.[cm]?[jt]sx?$/,
};

export const enumerateRepositorySourceFiles = (): string[] => {
  const files = execFileSync(AUTH_SOURCE_POPULATION.command, AUTH_SOURCE_POPULATION.arguments, {
    encoding: "utf8",
  }).split("\0");
  return [...new Set(files)].filter(
    (file) =>
      AUTH_SOURCE_POPULATION.extensions.test(file) &&
      !file.split("/").some((part) => part.startsWith(".env") || part === ".vercel"),
  );
};

export const MFA_OPT_OUT_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/server/auth/session.ts": {
    count: 3,
    reason: "Declares the MFA exception and defers MFA disclosure until after role refusal.",
  },
  "src/server/auth/mfa/mfa-route-guard.ts": {
    count: 1,
    reason: "MFA lifecycle handlers must run before MFA is satisfied.",
  },
  "src/server/auth/session.test.ts": {
    count: 2,
    reason: "Declares the test option type and exercises the explicit lifecycle exception.",
  },
  "src/server/auth/unsatisfied-mfa-opt-out.ts": {
    count: 1,
    reason: "Names the token inspected by the shared scanner.",
  },
  "src/server/auth/unsatisfied-mfa-opt-out.test.ts": {
    count: 19,
    reason: "Contains scanner fixtures for the prohibited token spellings.",
  },
  "scripts/testing/probes/session-mfa-default.mjs": {
    count: 1,
    reason: "Names the exact production guard removed by the existing MFA-default probe.",
  },
};

export const enumerateAuthSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.name.startsWith(".env") || entry.name === ".vercel") return [];
    return entry.isDirectory()
      ? enumerateAuthSourceFiles(file)
      : /\.[cm]?[jt]sx?$/.test(file)
        ? [file]
        : [];
  });

export const scanMfaOptOutNames = (text: string, file: string): number[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length > 0) throw new Error(`Cannot parse auth source: ${file}`);
  const lines: number[] = [];
  const sessionNames = new Set(["requireAuthenticatedSession"]);
  const initializers = new Map<string, ts.Expression>();
  const collectBindings = (node: ts.Node): void => {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === "requireAuthenticatedSession"
    ) {
      sessionNames.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(source);
  const hasUnclassifiedOptions = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return hasUnclassifiedOptions(expression.expression, seen);
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return false;
      if (seen.has(expression.text)) return true;
      seen.add(expression.text);
      const initializer = initializers.get(expression.text);
      return !initializer || hasUnclassifiedOptions(initializer, seen);
    }
    if (!ts.isObjectLiteralExpression(expression)) return true;
    return expression.properties.some(
      (property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name),
    );
  };
  const token = new RegExp(`\\b${MFA_OPT_OUT_NAME}\\b`, "g");
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      const options = node.arguments[0];
      if (name && sessionNames.has(name) && options && hasUnclassifiedOptions(options)) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    if (ts.isIdentifier(node) && node.text === MFA_OPT_OUT_NAME) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const match of node.text.matchAll(token)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const precedingLines = node.text.slice(0, match.index).split("\n").length - 1;
        lines.push(line + precedingLines);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

export const censusMfaOptOutNames = () =>
  enumerateRepositorySourceFiles().flatMap((file) => {
    const lines = scanMfaOptOutNames(readFileSync(file, "utf8"), file);
    return lines.length === 0 ? [] : [{ file, count: lines.length, lines }];
  });

export const createSessionGetterScanner = (files: Record<string, string>) => {
  const sources = new Map(Object.entries(files).map(([file, text]) => [resolve(file), text]));
  const options: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    paths: { "@/*": [resolve("src/*")] },
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  host.readFile = (file) => {
    if (file.split(/[\\/]/).some((part) => part.startsWith(".env") || part === ".vercel"))
      return undefined;
    return sources.get(resolve(file)) ?? readFile(file);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const results = new Map<ts.Node, boolean>();

  const declarationsOf = (expression: ts.Expression): readonly ts.Declaration[] => {
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      const type = checker.getTypeAtLocation(expression.expression);
      const property = type.getProperty(expression.argumentExpression.text);
      let symbol = property;
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      return symbol?.declarations ?? [];
    }
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  const reachesGetter = (node: ts.Node, visiting: Set<ts.Node>): boolean => {
    const cached = results.get(node);
    if (cached !== undefined) return cached;
    if (visiting.has(node)) return false;
    visiting.add(node);
    let found = false;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      found = expressionReadsSession(node.initializer, visiting);
    } else if (ts.isBindingElement(node)) {
      const binding = node.parent;
      const declaration = binding.parent;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const name = (node.propertyName ?? node.name).getText();
        const type = checker.getTypeAtLocation(declaration.initializer);
        const property = type.getProperty(name);
        found = property?.declarations?.some((entry) => reachesGetter(entry, visiting)) ?? false;
      }
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      found = node.body ? bodyReadsSession(node.body, visiting) : false;
    }
    visiting.delete(node);
    results.set(node, found);
    return found;
  };
  const expressionReadsSession = (expression: ts.Expression, visiting: Set<ts.Node>): boolean => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isAwaitExpression(expression)
    ) {
      return expressionReadsSession(expression.expression, visiting);
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
      return reachesGetter(expression, visiting);
    const declarations = declarationsOf(expression);
    for (const declaration of declarations) {
      const name =
        "name" in declaration && declaration.name && ts.isIdentifier(declaration.name as ts.Node)
          ? (declaration.name as ts.Identifier).text
          : undefined;
      if (name === "getCurrentSession" || name === "getServerSession") return true;
      // Existing page guards own the authenticated session read; wrappers get no exemption.
      if (
        declaration.getSourceFile().fileName.endsWith("/src/server/auth/page-guard.ts") &&
        (name === "requireRolePage" || name === "requireActiveSessionPage")
      )
        continue;
      if (reachesGetter(declaration, visiting)) return true;
    }
    if (declarations.length === 0) {
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (name === "getCurrentSession" || name === "getServerSession") return true;
    }
    return false;
  };
  const bodyReadsSession = (body: ts.Node, visiting: Set<ts.Node>): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node) && expressionReadsSession(node.expression, visiting))
        found = true;
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };

  return (file: string): number[] => {
    const source = program.getSourceFile(resolve(file));
    if (!source) throw new Error(`Cannot classify session source: ${file}`);
    const diagnostics = program.getSyntacticDiagnostics(source);
    if (diagnostics.length > 0) throw new Error(`Cannot parse session source: ${file}`);
    const lines: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && expressionReadsSession(node.expression, new Set())) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
  };
};
