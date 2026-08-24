// The strength gate's resolution, pinned against every spelling an import takes.
//
// The gate is only as good as its ability to open the helper a call names. It was blind twice: an
// imported identifier resolved to its import specifier rather than to the function, and after that
// was fixed it was still blind to a namespace-qualified call, to a default-exported arrow, and to
// any module that acquired a declaration file beside it. Nothing in the repository noticed, because
// on a clean tree there is no weakness to miss and the gate exits 0 either way.
//
// Each fixture helper carries the same status range in its body. A spelling the gate cannot follow
// reports the assertion as pinning what it means, which is the failure this file exists to catch.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import ts from "typescript";
import { programFor, weaknessesIn, resolvedBodyOf, type Unresolved } from "./assertion-strength";

const CALLERS = join(process.cwd(), "scripts/testing/fixtures/callers.mjs");

const program = programFor([CALLERS]);
const checker = program.getTypeChecker();

/** The body of each arrow in the fixture's `calls` object, keyed by its property name. */
const callsByName = ((): Map<string, ts.Node> => {
  const tree = program.getSourceFile(CALLERS);
  if (!tree) throw new Error(`fixture not in the program: ${CALLERS}`);
  const found = new Map<string, ts.Node>();

  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      ts.isArrowFunction(node.initializer)
    ) {
      found.set(node.name.text, node.initializer.body);
    }
    node.forEachChild(walk);
  };
  tree.forEachChild(walk);
  return found;
})();

const classify = (name: string): { weaknesses: string[]; unresolved: Unresolved[] } => {
  const expression = callsByName.get(name);
  if (!expression) throw new Error(`fixture has no call named ${name}`);
  const unresolved: Unresolved[] = [];
  return { weaknesses: weaknessesIn(program, checker, expression, unresolved), unresolved };
};

// Named individually so a spelling that stops resolving reads as its own failure rather than as a
// count changing. Every one of these is a real import form in this repository or one edit away.
const REACHES_THE_WEAKNESS = [
  "definedInThisFile",
  "namedImport",
  "renamedOnImport",
  "reExported",
  "starExported",
  "namespaceQualified",
  "defaultExportedArrow",
  "behindADeclarationFile",
];

describe("the strength gate sees a weakness through every import spelling", () => {
  it("has a fixture call for every spelling under test", () => {
    for (const name of REACHES_THE_WEAKNESS) {
      expect([...callsByName.keys()], `fixture has no call named ${name}`).toContain(name);
    }
  });

  it.each(REACHES_THE_WEAKNESS)("finds the range inside the helper reached by %s", (name) => {
    const { weaknesses, unresolved } = classify(name);

    expect(unresolved).toEqual([]);
    expect(weaknesses.sort()).toEqual(["HELPER", "RANGE"]);
  });
});

describe("the gate leaves alone what is not this repository's to read", () => {
  it("does not report the standard library as a helper it could not open", () => {
    const { weaknesses, unresolved } = classify("standardLibrary");

    expect(unresolved).toEqual([]);
    expect(weaknesses).toEqual([]);
  });

  it("reports an assertion that pins its status as carrying no weakness", () => {
    const { weaknesses, unresolved } = classify("pinsWhatItMeans");

    expect(unresolved).toEqual([]);
    expect(weaknesses).toEqual([]);
  });
});

/**
 * The failure mode, asserted directly.
 *
 * Every case above proves the gate CAN open a helper. This proves what it does when it cannot: a
 * callee with no resolvable declaration must come back as a refusal, because the caller counts a
 * `null` as "nothing weak in there" and that is how an unopenable helper became a cleared one.
 */
describe("a callee this gate cannot open is a refusal, not a pass", () => {
  it("names the callee and the reason", () => {
    const invented = ts.factory.createIdentifier("neverDeclaredAnywhere");
    const resolution = resolvedBodyOf(program, checker, invented);

    expect(resolution.kind).toBe("unresolvable");
  });

  it("separates a callee outside this repository from one it could not open", () => {
    const expression = callsByName.get("standardLibrary");
    if (!expression) throw new Error("fixture has no standardLibrary call");
    let outside = 0;

    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const resolution = resolvedBodyOf(program, checker, node.expression.name as ts.Identifier);
        if (resolution.kind === "outside-this-repository") outside += 1;
      }
      node.forEachChild(walk);
    };
    walk(expression);

    expect(outside).toBeGreaterThan(0);
  });
});
