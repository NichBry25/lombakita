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
  const token = new RegExp(`\\b${MFA_OPT_OUT_NAME}\\b`, "g");
  const visit = (node: ts.Node): void => {
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

type Target = { name: string; declaredIn: (fileName: string) => boolean };

const SESSION_FILE = "src/server/auth/session.ts";
const SESSION_GETTERS: readonly Target[] = [
  { name: "getCurrentSession", declaredIn: (fileName) => fileName === resolve(SESSION_FILE) },
  {
    name: "getServerSession",
    declaredIn: (fileName) => fileName.includes("/node_modules/next-auth/"),
  },
];
const PAGE_GUARD_FILE = "src/server/auth/page-guard.ts";
const EXEMPT_PAGE_GUARD_NAMES = ["requireRolePage", "requireActiveSessionPage"];
const MFA_GUARD_NAME = "requireAuthenticatedSession";
const MFA_GUARD_TARGETS: readonly Target[] = [
  { name: MFA_GUARD_NAME, declaredIn: (fileName) => fileName === resolve(SESSION_FILE) },
];
export const MFA_GUARD_EXEMPT_FILES = [SESSION_FILE, "src/server/auth/session.test.ts"];

type Reference = {
  node: ts.Node;
  symbol?: ts.Symbol;
  text?: string;
  opaqueObjectType?: ts.Type;
  moduleSymbol?: ts.Symbol;
  unclassifiable?: boolean;
  escapes?: boolean;
};

const createCheckedProgram = (files: Record<string, string>) => {
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
  const fileExists = host.fileExists;
  host.fileExists = (file) => sources.has(resolve(file)) || fileExists(file);
  host.readFile = (file) => {
    if (file.split(/[\\/]/).some((part) => part.startsWith(".env") || part === ".vercel"))
      return undefined;
    return sources.get(resolve(file)) ?? readFile(file);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  return { program, checker: program.getTypeChecker(), options, host };
};

const classifiedSourceFile = (program: ts.Program, file: string): ts.SourceFile => {
  const source = program.getSourceFile(resolve(file));
  if (!source) throw new Error(`Cannot classify session source: ${file}`);
  if (program.getSyntacticDiagnostics(source).length > 0)
    throw new Error(`Cannot parse session source: ${file}`);
  return source;
};

const lineOf = (node: ts.Node): number =>
  node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

// Finds every place a node can point at one of `targets`, whatever syntax carries the pointer:
// the symbol is resolved through aliases, re-exports, destructuring and property access by the
// type checker, so no spelling is enumerated here.
const createReferenceFinder = (
  checker: ts.TypeChecker,
  targets: readonly Target[],
  resolveRequiredModule: (specifier: string, fromFile: string) => ts.Symbol | undefined,
) => {
  const resolveAlias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarationName = (declaration: ts.Declaration): string | undefined => {
    if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration))
      return (declaration.propertyName ?? declaration.name).text;
    const name = ts.getNameOfDeclaration(declaration);
    return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
  };
  const matchesTarget = (symbol: ts.Symbol | undefined, text?: string): boolean => {
    const declarations = resolveAlias(symbol)?.declarations ?? [];
    if (declarations.length > 0) {
      return declarations.some((declaration) => {
        const name = declarationName(declaration);
        return targets.some(
          (target) =>
            target.name === name && target.declaredIn(declaration.getSourceFile().fileName),
        );
      });
    }
    const names = [text, ...(symbol?.declarations ?? []).map(declarationName)];
    return targets.some((target) => names.includes(target.name));
  };
  const typeExposesTarget = (type: ts.Type): boolean =>
    targets.some((target) => {
      const property = type.getProperty(target.name);
      return property !== undefined && matchesTarget(property);
    });
  const moduleExposesTarget = (moduleSymbol: ts.Symbol): boolean =>
    checker.getExportsOfModule(moduleSymbol).some((exported) => matchesTarget(exported));
  const isHit = (reference: Reference): boolean => {
    if (reference.opaqueObjectType) return typeExposesTarget(reference.opaqueObjectType);
    if (reference.escapes) return true;
    if (reference.moduleSymbol) return moduleExposesTarget(reference.moduleSymbol);
    if (reference.symbol || reference.text) return matchesTarget(reference.symbol, reference.text);
    return false;
  };

  const isDeclarationName = (identifier: ts.Identifier): boolean => {
    const parent = identifier.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)
    )
      return true;
    if (
      ts.isPropertyAccessExpression(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isExportSpecifier(parent)
    )
      return false;
    if (ts.isBindingElement(parent))
      return parent.name === identifier || parent.propertyName === identifier;
    return "name" in parent && (parent as { name?: ts.Node }).name === identifier;
  };
  const literalKeyText = (key: ts.Node): string | undefined => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
      return key.text;
    if (ts.isComputedPropertyName(key)) {
      const type = checker.getTypeAtLocation(key.expression);
      return type.isStringLiteral() ? type.value : undefined;
    }
    return undefined;
  };
  const bindingSourceType = (element: ts.BindingElement): ts.Type => {
    const pattern = element.parent;
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner) && owner.initializer)
      return checker.getTypeAtLocation(owner.initializer);
    return checker.getTypeAtLocation(pattern);
  };
  const isObjectOfMemberAccess = (identifier: ts.Identifier): boolean => {
    const parent = identifier.parent;
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === identifier
    );
  };

  const identifierReference = (identifier: ts.Identifier): Reference => {
    const parent = identifier.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(identifier);
    return { node: identifier, symbol, text: identifier.text };
  };
  const bindingElementReference = (element: ts.BindingElement): Reference => {
    const sourceType = bindingSourceType(element);
    const key = element.propertyName ?? element.name;
    const text = element.dotDotDotToken ? undefined : literalKeyText(key);
    if (text === undefined) return { node: element, opaqueObjectType: sourceType };
    return { node: element, symbol: sourceType.getProperty(text), text };
  };
  const elementAccessReference = (access: ts.ElementAccessExpression): Reference | undefined => {
    const objectType = checker.getTypeAtLocation(access.expression);
    const keyType = checker.getTypeAtLocation(access.argumentExpression);
    if (keyType.isStringLiteral())
      return { node: access, symbol: objectType.getProperty(keyType.value), text: keyType.value };
    if (keyType.flags & ts.TypeFlags.NumberLike) return undefined;
    return { node: access, opaqueObjectType: objectType };
  };
  const moduleReference = (node: ts.Node, specifier: ts.Expression | undefined): Reference => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return { node, unclassifiable: true };
    return { node, moduleSymbol: checker.getSymbolAtLocation(specifier) };
  };

  const isTransparentWrapper = (node: ts.Node): boolean =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node);
  const isNamespaceUseThatCannotEscape = (use: ts.Identifier): boolean => {
    const parent = use.parent;
    if (isObjectOfMemberAccess(use) || ts.isTypeQueryNode(parent)) return true;
    return (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === use &&
      ts.isObjectBindingPattern(parent.name)
    );
  };
  const isExportedVariable = (declaration: ts.VariableDeclaration): boolean =>
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;
  // `export { x }` names the variable through an alias symbol, so it has to be resolved to the
  // local target before it can be compared with the variable.
  const symbolReferenced = (identifier: ts.Identifier): ts.Symbol | undefined =>
    ts.isExportSpecifier(identifier.parent)
      ? checker.getExportSpecifierLocalTargetSymbol(identifier.parent)
      : identifierReference(identifier).symbol;
  const variableEscapes = (name: ts.Identifier): boolean => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return true;
    let escapes = false;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== name && !isDeclarationName(node)) {
        const isSameVariable = symbolReferenced(node) === symbol;
        if (isSameVariable && !isNamespaceUseThatCannotEscape(node)) escapes = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(name.getSourceFile());
    return escapes;
  };
  const thenCallbackEscapes = (thenCall: ts.CallExpression): boolean => {
    const callback = thenCall.arguments[0];
    if (!callback) return false;
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return true;
    const parameter = callback.parameters[0];
    if (!parameter) return false;
    if (ts.isObjectBindingPattern(parameter.name)) return false;
    return !ts.isIdentifier(parameter.name) || variableEscapes(parameter.name);
  };
  // A namespace that is only destructured or read member by member is judged by the member and
  // binding references. Anything that lets the whole namespace leave this expression is not.
  const dynamicImportNamespaceEscapes = (call: ts.CallExpression): boolean => {
    let current: ts.Expression = call;
    let awaited = false;
    while (isTransparentWrapper(current.parent)) {
      awaited = awaited || ts.isAwaitExpression(current.parent);
      current = current.parent as ts.Expression;
    }
    const parent = current.parent;
    if (ts.isExpressionStatement(parent)) return false;
    if (!awaited) {
      const isThenCall =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === current &&
        parent.name.text === "then" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      return !isThenCall || thenCallbackEscapes(parent.parent as ts.CallExpression);
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    )
      return false;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (ts.isObjectBindingPattern(parent.name)) return false;
      if (!ts.isIdentifier(parent.name)) return true;
      return isExportedVariable(parent) || variableEscapes(parent.name);
    }
    return true;
  };
  const dynamicImportReference = (call: ts.CallExpression): Reference | undefined => {
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier))
      return { node: call, unclassifiable: true };
    const moduleSymbol = checker.getSymbolAtLocation(specifier);
    if (!moduleSymbol) return undefined;
    if (!moduleExposesTarget(moduleSymbol)) return { node: call, moduleSymbol };
    return dynamicImportNamespaceEscapes(call) ? { node: call, escapes: true } : undefined;
  };

  const requireReference = (call: ts.CallExpression): Reference => {
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier))
      return { node: call, unclassifiable: true };
    const moduleSymbol = resolveRequiredModule(specifier.text, call.getSourceFile().fileName);
    return { node: call, moduleSymbol };
  };

  const collectReferences = (root: ts.Node, strict: boolean): Reference[] => {
    const references: Reference[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        references.push(identifierReference(node));
        if (strict && !isObjectOfMemberAccess(node)) {
          references.push({ node, opaqueObjectType: checker.getTypeAtLocation(node) });
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        references.push(bindingElementReference(node));
      } else if (ts.isElementAccessExpression(node)) {
        const reference = elementAccessReference(node);
        if (reference) references.push(reference);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const reference = dynamicImportReference(node);
        if (reference && (strict || !reference.unclassifiable)) references.push(reference);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const reference = requireReference(node);
        if (strict || !reference.unclassifiable) references.push(reference);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        (!node.exportClause || ts.isNamespaceExport(node.exportClause))
      ) {
        references.push(moduleReference(node, node.moduleSpecifier));
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return references;
  };

  return { collectReferences, isHit, resolveAlias };
};

const isWalkableDeclaration = (declaration: ts.Declaration): boolean => {
  const file = declaration.getSourceFile();
  if (file.isDeclarationFile || file.fileName.includes("/node_modules/")) return false;
  return (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isAccessor(declaration) ||
    ts.isClassLike(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isBindingElement(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isShorthandPropertyAssignment(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isExportAssignment(declaration)
  );
};

const createModuleResolver =
  (
    program: ts.Program,
    checker: ts.TypeChecker,
    options: ts.CompilerOptions,
    host: ts.CompilerHost,
  ) =>
  (specifier: string, fromFile: string): ts.Symbol | undefined => {
    const resolved = ts.resolveModuleName(specifier, fromFile, options, host).resolvedModule;
    const file = resolved && program.getSourceFile(resolved.resolvedFileName);
    return file && checker.getSymbolAtLocation(file);
  };

export const createSessionGetterScanner = (files: Record<string, string>) => {
  const { program, checker, options, host } = createCheckedProgram(files);
  const finder = createReferenceFinder(
    checker,
    SESSION_GETTERS,
    createModuleResolver(program, checker, options, host),
  );

  const exemptPageGuardDeclarations = new Set<ts.Declaration>();
  const pageGuardFile = program.getSourceFile(resolve(PAGE_GUARD_FILE));
  const pageGuardModule = pageGuardFile && checker.getSymbolAtLocation(pageGuardFile);
  for (const name of EXEMPT_PAGE_GUARD_NAMES) {
    const exported = pageGuardModule && checker.tryGetMemberInModuleExports(name, pageGuardModule);
    for (const declaration of exported?.declarations ?? [])
      exemptPageGuardDeclarations.add(declaration);
  }

  const walkableTargets = (symbol: ts.Symbol | undefined): ts.Declaration[] => {
    const declarations = finder.resolveAlias(symbol)?.declarations ?? [];
    if (declarations.some((declaration) => exemptPageGuardDeclarations.has(declaration))) return [];
    return declarations.filter(isWalkableDeclaration);
  };

  // A module reference reaches whatever the module exports, however the importer consumes it.
  const moduleExportTargets = (moduleSymbol: ts.Symbol | undefined): ts.Declaration[] =>
    moduleSymbol ? checker.getExportsOfModule(moduleSymbol).flatMap(walkableTargets) : [];
  const walkEdges = (reference: Reference): ts.Declaration[] => [
    ...walkableTargets(reference.symbol),
    ...moduleExportTargets(reference.moduleSymbol),
  ];

  type Outgoing = { violates: boolean; callees: ts.Declaration[] };
  const outgoingByDeclaration = new Map<ts.Node, Outgoing>();
  const outgoingOf = (declaration: ts.Node): Outgoing => {
    const cached = outgoingByDeclaration.get(declaration);
    if (cached) return cached;
    const outgoing: Outgoing = { violates: false, callees: [] };
    for (const reference of finder.collectReferences(declaration, true)) {
      if (reference.unclassifiable || finder.isHit(reference)) outgoing.violates = true;
      else outgoing.callees.push(...walkEdges(reference));
    }
    outgoingByDeclaration.set(declaration, outgoing);
    return outgoing;
  };
  const reachCache = new Map<ts.Node, boolean>();
  const reachesViolation = (root: ts.Node): boolean => {
    const known = reachCache.get(root);
    if (known !== undefined) return known;
    const visited = new Set<ts.Node>();
    const pending: ts.Node[] = [root];
    let found = false;
    while (pending.length > 0 && !found) {
      const current = pending.pop() as ts.Node;
      if (visited.has(current)) continue;
      visited.add(current);
      const cached = reachCache.get(current);
      if (cached === true) found = true;
      if (cached !== undefined) continue;
      const outgoing = outgoingOf(current);
      if (outgoing.violates) found = true;
      pending.push(...outgoing.callees);
    }
    if (found) reachCache.set(root, true);
    else for (const node of visited) reachCache.set(node, false);
    return found;
  };

  return (file: string): number[] => {
    const source = classifiedSourceFile(program, file);
    const lines = new Set<number>();
    for (const reference of finder.collectReferences(source, true)) {
      const violates =
        reference.unclassifiable ||
        finder.isHit(reference) ||
        walkEdges(reference).some(reachesViolation);
      if (violates) lines.add(lineOf(reference.node));
    }
    return [...lines].sort((left, right) => left - right);
  };
};

const isLiteralNamedBooleanAssignment = (property: ts.ObjectLiteralElementLike): boolean => {
  if (!ts.isPropertyAssignment(property)) return false;
  const literalName =
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name);
  const { kind } = property.initializer;
  const booleanLiteral = kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword;
  return literalName && booleanLiteral;
};

const hasLiteralOptions = (call: ts.CallExpression): boolean => {
  const options = call.arguments[0];
  if (!options) return true;
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.every(isLiteralNamedBooleanAssignment);
};

const isPlainDirectGuardCall = (reference: Reference): boolean => {
  const { node } = reference;
  if (!ts.isIdentifier(node) || !reference.symbol) return false;
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || parent.expression !== node || parent.questionDotToken)
    return false;
  return hasLiteralOptions(parent);
};

export const createMfaGuardReferenceScanner = (files: Record<string, string>) => {
  const { program, checker, options, host } = createCheckedProgram(files);
  const finder = createReferenceFinder(
    checker,
    MFA_GUARD_TARGETS,
    createModuleResolver(program, checker, options, host),
  );
  const exemptFiles = new Set(MFA_GUARD_EXEMPT_FILES.map((file) => resolve(file)));

  const isRenamedGuardImport = (node: ts.Node): boolean =>
    ts.isImportSpecifier(node) &&
    node.propertyName !== undefined &&
    finder.isHit({ node, symbol: checker.getSymbolAtLocation(node.name), text: node.name.text });

  return (file: string): number[] => {
    const source = classifiedSourceFile(program, file);
    if (exemptFiles.has(resolve(file))) return [];
    const lines = new Set<number>();
    const visitImports = (node: ts.Node): void => {
      if (isRenamedGuardImport(node)) lines.add(lineOf(node));
      ts.forEachChild(node, visitImports);
    };
    visitImports(source);
    for (const reference of finder.collectReferences(source, true)) {
      const violates =
        reference.unclassifiable || (finder.isHit(reference) && !isPlainDirectGuardCall(reference));
      if (violates) lines.add(lineOf(reference.node));
    }
    return [...lines].sort((left, right) => left - right);
  };
};

export const censusMfaGuardReferences = () => {
  const files = enumerateRepositorySourceFiles().filter((file) => file.startsWith("src/"));
  const scan = createMfaGuardReferenceScanner(
    Object.fromEntries(files.map((file) => [file, readFileSync(file, "utf8")])),
  );
  return files.flatMap((file) => {
    const lines = scan(file);
    return lines.length === 0 ? [] : [{ file, lines }];
  });
};
