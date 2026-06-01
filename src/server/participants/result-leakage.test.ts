// @vitest-environment node
//
// Step 5.3 leakage guard: the internal result fields (result_status, published_at) and
// the institution-internal review fields (internal_review_status, internal_notes) must
// never reach a candidate through the result read path. This test asserts that
// getPublishedResultForCandidate's DB select column list does not include these fields
// and that the returned shape omits them entirely.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { getPublishedResultForCandidate } from "@/server/participants/result-service";

describe("getPublishedResultForCandidate DB select does not expose institution-internal fields", () => {
  it("column allowlist for the result row select omits result_status, published_at, internalReviewStatus, internalNotes", async () => {
    const capturedSelects: Array<Record<string, unknown>> = [];

    const chain = (result: unknown[]): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.innerJoin = () => c;
      c.leftJoin = () => c;
      c.where = () => c;
      c.limit = () => Promise.resolve(result);
      c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return c;
    };

    let callCount = 0;
    const db = {
      select: (cols: Record<string, unknown>) => {
        capturedSelects.push(cols);
        callCount++;
        // First call: registration ownership check — return a matching row.
        if (callCount === 1) return chain([{ studentId: "cand_1" }]);
        // Second call: result row select (filtered by published status in WHERE) — return data.
        return chain([{ resultLabel: "Juara 1", resultNotes: null }]);
      },
    };

    await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db as never);

    // capturedSelects[1] is the result row select — verify its column allowlist.
    const resultSelectCols = capturedSelects[1] ?? {};
    const keys = Object.keys(resultSelectCols);

    // These fields must NOT be in the candidate-facing result select columns.
    // resultStatus is now filtered in the WHERE clause, not projected as a column.
    expect(keys).not.toContain("resultStatus");
    expect(keys).not.toContain("publishedAt");
    expect(keys).not.toContain("internalReviewStatus");
    expect(keys).not.toContain("internalNotes");

    // These fields MUST be present (the allowed candidate fields).
    expect(keys).toContain("resultLabel");
    expect(keys).toContain("resultNotes");
  });

  it("getPublishedResultForCandidate return shape contains only resultLabel and resultNotes", async () => {
    const chain = (result: unknown[]) => {
      const c: Record<string, unknown> = {
        from: () => c,
        innerJoin: () => c,
        leftJoin: () => c,
        where: () => c,
        limit: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return c;
    };
    let callCount = 0;
    const db = {
      select: () => {
        callCount++;
        if (callCount === 1) return chain([{ studentId: "cand_1" }]);
        // resultStatus is filtered in WHERE clause — only label and notes projected.
        return chain([{ resultLabel: "Winner", resultNotes: "Congrats" }]);
      },
    };

    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db as never);
    expect(result).not.toBeNull();
    const keys = Object.keys(result ?? {});
    // Exactly these two keys and no others.
    expect(keys.sort()).toEqual(["resultLabel", "resultNotes"].sort());
  });
});
