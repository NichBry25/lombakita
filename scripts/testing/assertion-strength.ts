/**
 * Reports which api-matrix assertions cannot fail for the reason their name gives.
 *
 * WHY THIS IS NOT A GREP. The previous count "covered only the explicit range form", so it saw
 * `r.status >= 400 && r.status < 500` and missed `is2xx(r)`, missed a disjunction of two statuses,
 * and missed every substring needle. A line window cannot tell an assertion from a comment that
 * mentions one, and cannot see which argument of `record()` it is looking at. This resolves each
 * `record(...)` call against the parsed syntax tree and classifies its FIFTH argument — the
 * expression that decides pass or fail — and nothing else.
 *
 * The four weak forms, and what each one lets through:
 *
 *   RANGE       `status >= 400 && status < 500` — a payload-validation 400 satisfies an assertion
 *               named for a policy refusal. Measured live: CAND-15 sent the wrong field name and
 *               was rejected by the parser, never reaching the cancellation gate it names.
 *   HELPER      a call whose own body carries one of the other three. The callee is RESOLVED
 *               through the type checker, not matched by name: this class used to be the single
 *               hardcoded identifier `is2xx`, which the same change that wrote this file deleted,
 *               so the class detected nothing while `refusedWith` — four call sites — was
 *               invisible to it. A helper is only as strong as what its body does.
 *   DISJUNCTION `status === 401 || status === 403` — passes on whichever the code happens to do,
 *               so a change from one to the other is invisible.
 *   SUBSTRING   `JSON.stringify(body).includes("…")` — satisfied by any longer string containing
 *               the needle, including one that says the opposite.
 *
 * Usage: node --import tsx scripts/testing/assertion-strength.ts [--list]
 * Exit code: 0 when every assertion pins what it means; 1 otherwise.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ASSERTION_HARNESSES } from "./assertion-harnesses";

type Weakness = "RANGE" | "HELPER" | "DISJUNCTION" | "SUBSTRING";

/** A callee this gate opened, one it has no business opening, or one it could not open. */
export type Resolution =
  | { kind: "body"; body: ts.Node }
  | { kind: "outside-this-repository" }
  | { kind: "unresolvable"; reason: string };

export type Unresolved = { callee: string; reason: string };

type Assertion = {
  harness: string;
  id: string;
  name: string;
  source: string;
  weaknesses: Weakness[];
  unresolved: Unresolved[];
};

const REPO_ROOT = process.cwd();
const HARNESSES = ASSERTION_HARNESSES.map((relative) => resolve(REPO_ROOT, relative));

/** `.status` on anything — the property every range form compares. */
const isStatusAccess = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) && node.name.text === "status";

const RANGE_OPERATORS = new Set([
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

/**
 * Whether `.includes()` on this receiver is a SUBSTRING search rather than array membership.
 *
 * The distinction is the whole difference between a weak assertion and a correct one:
 * `allSlugs.includes(slug)` is exact and fine, `serialised.includes(slug)` is satisfied by any
 * longer string containing it. Only the type checker can tell them apart — the two calls are
 * spelled identically — which is why this resolves against a real program rather than a regex.
 */
const isStringReceiver = (checker: ts.TypeChecker, receiver: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(receiver);
  const types = type.isUnion() ? type.types : [type];
  return types.some(
    (candidate) => (candidate.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0,
  );
};

/** A file this repository owns, as opposed to the standard library or a dependency. */
const isThisRepository = (file: ts.SourceFile): boolean =>
  file.fileName.startsWith(REPO_ROOT) && !file.fileName.includes("/node_modules/");

/**
 * The implementation a declaration file describes: `lib-assertions.d.mts` names
 * `lib-assertions.mjs`.
 *
 * A `.d.mts` beside a helper module is an ordinary, well-intentioned act, and it used to blind this
 * gate completely: `moduleResolution: Bundler` prefers the declaration file, a declaration file has
 * no body, and every assertion behind that helper read as strong. Five such pairs already sit in
 * `scripts/testing/`, so the next one is one edit away.
 */
const implementationFor = (declarationFile: string): string | null => {
  const match = declarationFile.match(/^(.*)\.d\.(m?ts)$/);
  if (!match) return null;
  const [, stem, flavour] = match;
  const candidates =
    flavour === "mts" ? [`${stem}.mjs`, `${stem}.mts`] : [`${stem}.ts`, `${stem}.js`];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

/** The function body a declaration carries, in each of the shapes a helper is written in. */
const bodyOfDeclaration = (declaration: ts.Declaration): ts.Node | null => {
  if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) {
    return declaration.body ?? null;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer.body;
    }
  }
  // `export default (r) => …`, where the declaration IS the export assignment and the function is
  // its expression. `export default function f(){}` lands on the first branch, and
  // `const f = …; export default f;` resolves through the alias to the variable.
  if (ts.isExportAssignment(declaration)) {
    const expression = declaration.expression;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return expression.body;
    }
  }
  return null;
};

/**
 * Whether `receiver` is a namespace import of a module this repository owns.
 *
 * The question a property-access callee has to answer before the gate opens it: `A.refusedWith(r)`
 * where `A` is `import * as A from "./lib-assertions.mjs"` is a helper this repository wrote, and
 * `body.includes(x)` is a method on an untyped local that belongs to the language.
 */
const namesAModuleOfThisRepository = (
  checker: ts.TypeChecker,
  receiver: ts.Expression,
): boolean => {
  const local = checker.getSymbolAtLocation(receiver);
  if (!local) return false;
  const symbol = local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !ts.isSourceFile(declaration)) return false;
  return isThisRepository(declaration);
};

/**
 * The body of the function `callee` names.
 *
 * THE ALIAS UNWRAP IS NOT A DETAIL. An imported identifier resolves to its `import` specifier, not
 * to the function it names, so a helper defined in the file that calls it was read and the same
 * helper moved into a shared module was invisible — and moving them into a shared module is exactly
 * what Rule 37 asks for. A probe caught this: `refusedWith` was weakened to a status range inside
 * `lib-assertions.mjs` and the gate reported all 122 assertions strong.
 *
 * FAILING TO RESOLVE IS A REFUSAL, NOT A PASS. This returned `null` for every case it could not
 * open, and the caller read `null` as "nothing weak in there" — so a helper the gate could not see
 * counted as one it had cleared. That is the same sentence this file already prints when a
 * `record()` call has no pass expression, and it was true one layer down the whole time. A callee
 * outside this repository is a separate answer: the standard library and the dependencies are not
 * this gate's business, and treating them as unresolvable would make it refuse `Object.keys`.
 */
export const resolvedBodyOf = (
  program: ts.Program,
  checker: ts.TypeChecker,
  callee: ts.Identifier,
): Resolution => {
  const local = checker.getSymbolAtLocation(callee);
  const symbol =
    local && local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) {
    return { kind: "unresolvable", reason: "no declaration for this callee" };
  }

  const file = declaration.getSourceFile();
  if (!isThisRepository(file)) return { kind: "outside-this-repository" };

  if (file.isDeclarationFile) {
    const implementation = implementationFor(file.fileName);
    if (!implementation) {
      return { kind: "unresolvable", reason: `${file.fileName} has no implementation beside it` };
    }
    const source = program.getSourceFile(implementation);
    if (!source) {
      return { kind: "unresolvable", reason: `${implementation} is not in this program` };
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exported = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol).find((s) => s.name === symbol?.name)
      : undefined;
    const implemented = exported?.valueDeclaration ?? exported?.declarations?.[0];
    const body = implemented ? bodyOfDeclaration(implemented) : null;
    if (!body) {
      return {
        kind: "unresolvable",
        reason: `${symbol?.name ?? callee.text} is declared in ${file.fileName} and not found as a function in ${implementation}`,
      };
    }
    return { kind: "body", body };
  }

  const body = bodyOfDeclaration(declaration);
  if (!body) {
    return {
      kind: "unresolvable",
      reason: `${ts.SyntaxKind[declaration.kind]} in ${file.fileName} is not a function this gate knows how to open`,
    };
  }
  return { kind: "body", body };
};

export const weaknessesIn = (
  program: ts.Program,
  checker: ts.TypeChecker,
  expression: ts.Node,
  unresolved: Unresolved[],
  visited: Set<ts.Node> = new Set(),
): Weakness[] => {
  const found = new Set<Weakness>();
  const equalityComparisonsOnStatus: ts.BinaryExpression[] = [];

  const walk = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      if (RANGE_OPERATORS.has(node.operatorToken.kind)) {
        if (isStatusAccess(node.left) || isStatusAccess(node.right)) found.add("RANGE");
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        if (isStatusAccess(node.left) || isStatusAccess(node.right)) {
          equalityComparisonsOnStatus.push(node);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // A namespace-qualified callee is the same helper wearing a different import. `import * as A`
      // followed by `A.refusedWith(...)` took the property-access branch below, which only ever
      // asked whether the call was `.includes`, so the helper body was never opened — one import
      // line away from blinding the gate across every assertion in a harness.
      //
      // Only when the RECEIVER is a module this repository owns. `body.includes(x)` is a property
      // on an untyped local, and every such call would otherwise be reported as a helper the gate
      // could not open, which would make the refusal fire on the standard library rather than on
      // anything this gate is responsible for.
      const named = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.name) &&
            namesAModuleOfThisRepository(checker, callee.expression)
          ? callee.name
          : null;
      if (named) {
        const resolution = resolvedBodyOf(program, checker, named);
        if (resolution.kind === "unresolvable") {
          unresolved.push({ callee: named.text, reason: resolution.reason });
        }
        if (resolution.kind === "body" && !visited.has(resolution.body)) {
          visited.add(resolution.body);
          for (const weakness of weaknessesIn(
            program,
            checker,
            resolution.body,
            unresolved,
            visited,
          )) {
            found.add("HELPER");
            found.add(weakness);
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "includes" &&
        isStringReceiver(checker, callee.expression)
      ) {
        found.add("SUBSTRING");
      }
    }
    node.forEachChild(walk);
  };
  walk(expression);

  // Two or more `status === N` joined by `||` is a range with the middle removed: the assertion
  // holds whichever answer the code gives, so a change between them cannot fail it.
  if (equalityComparisonsOnStatus.length > 1) {
    const hasOr = (node: ts.Node): boolean => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        equalityComparisonsOnStatus.some((c) => c.pos >= node.pos && c.end <= node.end)
      ) {
        return true;
      }
      return node.getChildren().some(hasOr);
    };
    if (hasOr(expression)) found.add("DISJUNCTION");
  }

  return [...found];
};

/**
 * Every implementation file that a declaration file in the harnesses' own directories describes.
 *
 * They are root files because resolution prefers the `.d.mts`, so the `.mjs` beside it would
 * otherwise not be in the program at all and the gate would have nowhere to look for the body.
 */
const implementationsBesideDeclarations = (harnesses: string[]): string[] => {
  const directories = [...new Set(harnesses.map((harness) => dirname(harness)))];
  return directories.flatMap((directory) =>
    readdirSync(directory)
      .filter((entry) => /\.d\.m?ts$/.test(entry))
      .map((entry) => implementationFor(join(directory, entry)))
      .filter((path): path is string => path !== null),
  );
};

export const programFor = (harnesses: string[]): ts.Program =>
  // A full program, not a lone source file: the receiver of `.includes()` has to be TYPED before
  // the classifier can say whether it is searching a string or a list.
  ts.createProgram([...harnesses, ...implementationsBesideDeclarations(harnesses)], {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  });

const collect = (): { assertions: Assertion[]; unreadable: Assertion[] } => {
  const program = programFor(HARNESSES);
  const checker = program.getTypeChecker();
  const assertions: Assertion[] = [];
  // A `record(...)` with nothing in the pass position is not a passing assertion — it is one this
  // gate cannot read. Skipping it silently would lower the reported total with nothing saying so,
  // which is the shape of the defect this file exists for.
  const unreadable: Assertion[] = [];

  for (const path of HARNESSES) {
    const tree = program.getSourceFile(path);
    if (!tree) throw new Error(`could not parse ${path}`);
    const harness = path.slice(path.lastIndexOf("/") + 1);

    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "record"
      ) {
        const [idArg, nameArg] = node.arguments;
        const pass = node.arguments[4];
        const identity = {
          harness,
          id: idArg && ts.isStringLiteralLike(idArg) ? idArg.text : "(computed)",
          name: nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : "(computed)",
        };

        if (pass) {
          const unresolved: Unresolved[] = [];
          assertions.push({
            ...identity,
            source: pass.getText().replace(/\s+/g, " ").slice(0, 120),
            weaknesses: weaknessesIn(program, checker, pass, unresolved),
            unresolved,
          });
        } else {
          unreadable.push({
            ...identity,
            source: `${node.arguments.length} argument(s); nothing in the pass position`,
            weaknesses: [],
            unresolved: [],
          });
        }
      }
      node.forEachChild(walk);
    };
    tree.forEachChild(walk);
  }

  return { assertions, unreadable };
};

const main = (): void => {
  const { assertions, unreadable } = collect();
  const weak = assertions.filter((a) => a.weaknesses.length > 0);
  const unresolved = assertions.filter((a) => a.unresolved.length > 0);

  if (process.argv.includes("--list")) {
    for (const assertion of assertions) {
      const verdict = assertion.weaknesses.length ? assertion.weaknesses.join("+") : "pins";
      console.log(
        `${verdict.padEnd(22)} ${assertion.harness.padEnd(16)} ${assertion.id.padEnd(18)} ${assertion.source}`,
      );
    }
    console.log("");
  }

  const byKind = new Map<Weakness, number>();
  for (const assertion of weak) {
    for (const weakness of assertion.weaknesses) {
      byKind.set(weakness, (byKind.get(weakness) ?? 0) + 1);
    }
  }

  const perHarness = new Map<string, number>();
  for (const assertion of assertions) {
    perHarness.set(assertion.harness, (perHarness.get(assertion.harness) ?? 0) + 1);
  }

  console.log(
    `${assertions.length} assertions; ${weak.length} cannot fail for the reason they name.`,
  );
  for (const [harness, count] of perHarness) console.log(`  ${harness.padEnd(20)} ${count}`);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(20)} ${count}`);
  }

  if (unreadable.length > 0) {
    console.error(`\n${unreadable.length} record() call(s) this gate could not read:`);
    for (const entry of unreadable) {
      console.error(`  ${entry.harness}  ${entry.id}  ${entry.source}`);
    }
    console.error(
      `\nAn assertion the gate cannot classify is not one it has cleared. Give the call its pass ` +
        `expression, or the reported total describes fewer assertions than the harness contains.`,
    );
    process.exit(1);
  }

  // The same sentence as above, one layer down, and it was the missing half. A helper this gate
  // could not open was counted as one it had cleared, so a weakness written inside an unopenable
  // helper read as a pinned assertion.
  if (unresolved.length > 0) {
    console.error(`\n${unresolved.length} assertion(s) call a helper this gate could not open:`);
    for (const assertion of unresolved) {
      for (const entry of assertion.unresolved) {
        console.error(`  ${assertion.harness}  ${assertion.id}  ${entry.callee}: ${entry.reason}`);
      }
    }
    console.error(
      `\nA helper the gate cannot open is not one it has cleared: its body could carry any of the ` +
        `four weak forms and nothing here would see it. Make the helper resolvable, or say why it ` +
        `is not this repository's to read.`,
    );
    process.exit(1);
  }

  if (weak.length > 0) {
    console.log(
      `\nRun with --list to see them. An assertion must pin the status it means and the body it ` +
        `means: \`r.status === 409\` and \`r.body?.error?.code === "…"\`, not a range and not a ` +
        `substring of the serialised response.`,
    );
    process.exit(1);
  }
};

// Exported as functions and run only when this file IS the entry point, so a test can drive the
// resolution against fixtures without the gate walking the harnesses to get there.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
