import { describe, expect, it } from "vitest";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { MAX_MINOR_UNIT_AMOUNT } from "@/lib/finance/money";

describe("isPaidCompetition", () => {
  it("treats a positive integer fee as paid", () => {
    expect(isPaidCompetition(50_000)).toBe(true);
    expect(isPaidCompetition(1)).toBe(true);
  });

  it("treats null, undefined and zero alike as free", () => {
    // "No fee set" and "the fee is nothing" mean the same thing to a candidate registering.
    expect(isPaidCompetition(null)).toBe(false);
    expect(isPaidCompetition(undefined)).toBe(false);
    expect(isPaidCompetition(0)).toBe(false);
  });

  it("treats a non-integer or unsafe value as FREE, not paid", () => {
    // The fail-safe direction. The alternative would let a corrupt value switch a competition into
    // the paid lane and demand money under a figure nothing downstream can interpret.
    expect(isPaidCompetition(50_000.5)).toBe(false);
    expect(isPaidCompetition(Number.NaN)).toBe(false);
    expect(isPaidCompetition(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPaidCompetition(MAX_MINOR_UNIT_AMOUNT + 2)).toBe(false);
  });

  it("treats a negative fee as free", () => {
    expect(isPaidCompetition(-1)).toBe(false);
  });
});
