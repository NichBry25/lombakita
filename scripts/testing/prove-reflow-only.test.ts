// What the reflow proof can see that a whitespace-collapsed diff cannot.
//
// The whitespace method was offered as evidence that a Prettier pass changed nothing, and rejected:
// it cannot look inside a template literal, and an assertion harness is largely made of them. These
// pin both halves — that a genuine reflow reads as identical, and that the specific edit the cheap
// method is blind to reads as a difference.

import { describe, expect, it } from "vitest";
import { divergence, shapeOf } from "./prove-reflow-only";

const shapesMatch = (before: string, after: string): boolean =>
  divergence(shapeOf(before, "a.mjs"), shapeOf(after, "a.mjs")).identical;

describe("a reflow is reported as reflow", () => {
  it("sees no change when Prettier wraps an argument list and adds a trailing comma", () => {
    const before = `record("R2-01", "presign returns a signed PUT", 200, r.status, r.status === 200);`;
    const after = `record(\n  "R2-01",\n  "presign returns a signed PUT",\n  200,\n  r.status,\n  r.status === 200,\n);`;

    expect(shapesMatch(before, after)).toBe(true);
  });

  it("sees no change when quote style is normalised", () => {
    expect(shapesMatch(`const a = 'x';`, `const a = "x";`)).toBe(true);
  });

  it("sees no change when a redundant parenthesis is dropped", () => {
    expect(shapesMatch(`const a = (b + c);`, `const a = b + c;`)).toBe(true);
  });
});

describe("an edit inside a template literal is reported as a change", () => {
  // The whole reason a whitespace-collapsing diff is not a proof. Both of these normalise to the
  // same string once runs of whitespace are collapsed, and they assert different things.
  it("sees the difference between two orderings of the same interpolations", () => {
    const before = "const note = `${expected} vs ${actual}`;";
    const after = "const note = `${actual} vs ${expected}`;";

    expect(shapesMatch(before, after)).toBe(false);
  });

  it("sees a changed cooked value even when only spacing differs", () => {
    const before = "const label = `expected  ${code}`;";
    const after = "const label = `expected ${code}`;";

    expect(shapesMatch(before, after)).toBe(false);
  });

  it("sees a status changed inside an interpolated assertion note", () => {
    const before = "const note = `${r.status} 403`;";
    const after = "const note = `${r.status} 404`;";

    expect(shapesMatch(before, after)).toBe(false);
  });
});

describe("the divergence report", () => {
  it("names the region that differs rather than only that one does", () => {
    const before = `const a = 1;\nconst b = 2;\nconst c = 3;`;
    const after = `const a = 1;\nconst b = 99;\nconst c = 3;`;

    const result = divergence(shapeOf(before, "a.mjs"), shapeOf(after, "a.mjs"));

    expect(result.identical).toBe(false);
    expect(result.removed).toContain('text:"2"');
    expect(result.added).toContain('text:"99"');
  });
});
