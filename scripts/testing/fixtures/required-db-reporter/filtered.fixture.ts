import { describe, expect, it } from "vitest";

describe("required-db-reporter fixture", () => {
  it("runs under the pattern", () => {
    expect(1 + 1).toBe(2);
  });

  it.skip("is silenced under the pattern", () => {
    expect(1 + 1).toBe(3);
  });

  it("stands outside the pattern", () => {
    expect(1 + 1).toBe(2);
  });
});
