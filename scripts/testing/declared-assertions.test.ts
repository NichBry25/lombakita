// The declared assertion set, pinned against the assertions that exist.
//
// The list in declared-assertions.mjs is what `r2-flows` says it checks, and it is the denominator
// its summary reports against. That is only true while the list and the harness agree, so this
// resolves the harness's `record()` calls from the parsed syntax tree — a grep cannot tell a call
// from the same text inside a comment or a template string — and holds the two to each other in
// both directions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { R2_FLOWS_ASSERTIONS, unreachedAssertions } from "./declared-assertions.mjs";

const HARNESS = "scripts/testing/r2-flows.mjs";

/** Every id passed as the first argument of a `record(...)` call in `path`. */
const idsRecordedBy = (path: string): string[] => {
  const source = readFileSync(join(process.cwd(), path), "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "record"
    ) {
      const first = node.arguments[0];
      // A computed id would defeat the pin, so it is a failure rather than a skip. The accounting
      // loop's own `record(id, …)` passes a variable and is excluded by that loop being the one
      // place the id comes from the declaration itself.
      if (first && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    node.forEachChild(walk);
  };

  tree.forEachChild(walk);
  return found;
};

const recorded = idsRecordedBy(HARNESS);

describe("the declared assertion set and the harness agree", () => {
  it("declares every id the harness records", () => {
    for (const id of recorded) {
      expect(R2_FLOWS_ASSERTIONS, `${id} is recorded but not declared`).toContain(id);
    }
  });

  it("records every id it declares", () => {
    for (const id of R2_FLOWS_ASSERTIONS) {
      expect(recorded, `${id} is declared but nothing records it`).toContain(id);
    }
  });

  it("declares each id exactly once", () => {
    expect(new Set(R2_FLOWS_ASSERTIONS).size).toBe(R2_FLOWS_ASSERTIONS.length);
  });

  // The number the summary divides by. Named so a dropped assertion reads as a dropped assertion.
  it("declares the twenty-two the harness is accountable for", () => {
    expect(R2_FLOWS_ASSERTIONS.length).toBe(22);
  });
});

describe("an assertion that did not run is not an absence", () => {
  it("names every declared id no result speaks for", () => {
    const results = [{ id: "R2-01" }, { id: "DOC-01" }];

    expect(unreachedAssertions(["R2-01", "R2-02", "DOC-01", "DOC-02"], results)).toEqual([
      "R2-02",
      "DOC-02",
    ]);
  });

  it("names none when every declared id ran", () => {
    const results = R2_FLOWS_ASSERTIONS.map((id) => ({ id }));

    expect(unreachedAssertions(R2_FLOWS_ASSERTIONS, results)).toEqual([]);
  });

  // The shape the harness actually hits: an upstream failure closes the `if` that seven pins live
  // inside, and every one of them has to surface rather than shrink the divisor.
  it("names the whole tail when a guard closed over it", () => {
    const ran = R2_FLOWS_ASSERTIONS.slice(0, 15).map((id) => ({ id }));

    expect(unreachedAssertions(R2_FLOWS_ASSERTIONS, ran)).toEqual(R2_FLOWS_ASSERTIONS.slice(15));
  });
});
