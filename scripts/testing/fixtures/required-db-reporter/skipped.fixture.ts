import { describe, expect, it } from "vitest";

describe("required-db-reporter fixture", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });

  it.skip("is silenced", () => {
    expect(1 + 1).toBe(3);
  });
});
