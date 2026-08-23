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
import { resolve } from "node:path";
import ts from "typescript";
import { ASSERTION_HARNESSES } from "./assertion-harnesses";

type Weakness = "RANGE" | "HELPER" | "DISJUNCTION" | "SUBSTRING";

type Assertion = {
  harness: string;
  id: string;
  name: string;
  source: string;
  weaknesses: Weakness[];
};

const HARNESSES = ASSERTION_HARNESSES.map((relative) => resolve(process.cwd(), relative));

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

/**
 * The body of the function `callee` names, when this program can see it.
 *
 * Declaration files are skipped: a `.d.ts` has no body to read, and following one would resolve
 * into the standard library rather than into this repository's own helpers.
 *
 * The ALIAS unwrap is not a detail. An imported identifier resolves to its `import` specifier, not
 * to the function it names, so a helper defined in the file that calls it was read and the same
 * helper moved into a shared module was invisible — and moving them into a shared module is
 * exactly what Rule 37 asks for. A probe caught this: `refusedWith` was weakened to a status range
 * inside `lib-assertions.mjs` and the gate reported all 122 assertions strong.
 */
const resolvedBodyOf = (checker: ts.TypeChecker, callee: ts.Identifier): ts.Node | null => {
  const local = checker.getSymbolAtLocation(callee);
  const symbol =
    local && local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return null;
  if (declaration.getSourceFile().isDeclarationFile) return null;

  if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) {
    return declaration.body ?? null;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer.body;
    }
  }
  return null;
};

const weaknessesIn = (
  checker: ts.TypeChecker,
  expression: ts.Node,
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
      if (ts.isIdentifier(callee)) {
        const body = resolvedBodyOf(checker, callee);
        if (body && !visited.has(body)) {
          visited.add(body);
          for (const weakness of weaknessesIn(checker, body, visited)) {
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

const collect = (): { assertions: Assertion[]; unreadable: Assertion[] } => {
  // A full program, not a lone source file: the receiver of `.includes()` has to be TYPED before
  // the classifier can say whether it is searching a string or a list.
  const program = ts.createProgram(HARNESSES, {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  });
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
          assertions.push({
            ...identity,
            source: pass.getText().replace(/\s+/g, " ").slice(0, 120),
            weaknesses: weaknessesIn(checker, pass),
          });
        } else {
          unreadable.push({
            ...identity,
            source: `${node.arguments.length} argument(s); nothing in the pass position`,
            weaknesses: [],
          });
        }
      }
      node.forEachChild(walk);
    };
    tree.forEachChild(walk);
  }

  return { assertions, unreadable };
};

const { assertions, unreadable } = collect();
const weak = assertions.filter((a) => a.weaknesses.length > 0);

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

if (weak.length > 0) {
  console.log(
    `\nRun with --list to see them. An assertion must pin the status it means and the body it ` +
      `means: \`r.status === 409\` and \`r.body?.error?.code === "…"\`, not a range and not a ` +
      `substring of the serialised response.`,
  );
  process.exit(1);
}
