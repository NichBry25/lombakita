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
 *   HELPER      `is2xx(r)` — the same range wearing a helper's name.
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

type Weakness = "RANGE" | "HELPER" | "DISJUNCTION" | "SUBSTRING";

type Assertion = {
  id: string;
  name: string;
  source: string;
  weaknesses: Weakness[];
};

const MATRIX = resolve(process.cwd(), "scripts/testing/api-matrix.mjs");

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
    (candidate) =>
      (candidate.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0,
  );
};

const weaknessesIn = (checker: ts.TypeChecker, expression: ts.Expression): Weakness[] => {
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
      if (ts.isIdentifier(callee) && callee.text === "is2xx") found.add("HELPER");
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

const collect = (): Assertion[] => {
  // A full program, not a lone source file: the receiver of `.includes()` has to be TYPED before
  // the classifier can say whether it is searching a string or a list.
  const program = ts.createProgram([MATRIX], {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const tree = program.getSourceFile(MATRIX);
  if (!tree) throw new Error(`could not parse ${MATRIX}`);
  const assertions: Assertion[] = [];

  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "record" &&
      node.arguments.length >= 5
    ) {
      const [idArg, nameArg] = node.arguments;
      const pass = node.arguments[4];
      if (pass) {
        assertions.push({
          id: ts.isStringLiteralLike(idArg!) ? idArg.text : "(computed)",
          name: ts.isStringLiteralLike(nameArg!) ? nameArg.text : "(computed)",
          source: pass.getText().replace(/\s+/g, " ").slice(0, 120),
          weaknesses: weaknessesIn(checker, pass),
        });
      }
    }
    node.forEachChild(walk);
  };
  tree.forEachChild(walk);
  return assertions;
};

const assertions = collect();
const weak = assertions.filter((a) => a.weaknesses.length > 0);

if (process.argv.includes("--list")) {
  for (const assertion of assertions) {
    const verdict = assertion.weaknesses.length ? assertion.weaknesses.join("+") : "pins";
    console.log(`${verdict.padEnd(22)} ${assertion.id.padEnd(18)} ${assertion.source}`);
  }
  console.log("");
}

const byKind = new Map<Weakness, number>();
for (const assertion of weak) {
  for (const weakness of assertion.weaknesses) {
    byKind.set(weakness, (byKind.get(weakness) ?? 0) + 1);
  }
}

console.log(`${assertions.length} assertions; ${weak.length} cannot fail for the reason they name.`);
for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(12)} ${count}`);
}

if (weak.length > 0) {
  console.log(
    `\nRun with --list to see them. An assertion must pin the status it means and the body it ` +
      `means: \`r.status === 409\` and \`r.body?.error?.code === "…"\`, not a range and not a ` +
      `substring of the serialised response.`,
  );
  process.exit(1);
}
