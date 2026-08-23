// The declaration and the population, pinned against each other.
//
// A harness owns assertions when it declares its own `record(id, name, expected, actual, pass)`.
// Every file that does must be in ASSERTION_HARNESSES, so adding a harness without extending the
// declaration fails here rather than quietly halving what the gate covers — which is what happened
// to r2-flows.mjs for the whole of its life before this.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ASSERTION_HARNESSES } from "./assertion-harnesses";

const TESTING_DIR = join(process.cwd(), "scripts/testing");

/**
 * True when `path` declares a `record` that takes a pass expression in the fifth position.
 *
 * The arity is the point. A `record` of a different shape is a different thing that happens to
 * share a name, and the gate — which classifies argument index four — would read it wrongly.
 */
const declaresAssertionRecord = (path: string): boolean => {
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let found = false;

  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "record" &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.parameters.length >= 5
    ) {
      found = true;
    }
    node.forEachChild(walk);
  };

  tree.forEachChild(walk);
  return found;
};

const harnessesOnDisk = readdirSync(TESTING_DIR)
  .filter((name) => name.endsWith(".mjs"))
  .filter((name) => declaresAssertionRecord(join(TESTING_DIR, name)))
  .map((name) => `scripts/testing/${name}`)
  .sort();

describe("ASSERTION_HARNESSES declares every file that owns assertions", () => {
  it("finds the harnesses on disk at all", () => {
    expect(harnessesOnDisk.length).toBeGreaterThan(0);
  });

  it("declares exactly the files that declare an assertion record", () => {
    expect([...ASSERTION_HARNESSES].sort()).toEqual(harnessesOnDisk);
  });

  // Named individually, so removing one reads as a removal in the diff.
  it("covers both harnesses this step is accountable for", () => {
    expect([...ASSERTION_HARNESSES].sort()).toEqual([
      "scripts/testing/api-matrix.mjs",
      "scripts/testing/r2-flows.mjs",
    ]);
  });
});
