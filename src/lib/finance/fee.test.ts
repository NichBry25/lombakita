// @vitest-environment node

import { describe, expect, it } from "vitest";
import { computePlatformFee, FeeComputationError, type FeeRuleTerms } from "@/lib/finance/fee";
import {
  CURRENCY_EXPONENTS,
  isIso4217Code,
  isMinorUnitAmount,
  isSupportedCurrency,
  MAX_MINOR_UNIT_AMOUNT,
} from "@/lib/finance/money";

const terms = (overrides: Partial<FeeRuleTerms> = {}): FeeRuleTerms => ({
  basisPoints: 0,
  flatAmount: 0,
  minimumFeeAmount: null,
  maximumFeeAmount: null,
  currency: "IDR",
  ...overrides,
});

describe("money representation", () => {
  it("declares IDR at exponent 0, so a stored integer is a whole rupiah", () => {
    // If this ever reads 2, every amount already stored becomes 100x too large. It is the whole
    // reason the convention is written down in one place.
    expect(CURRENCY_EXPONENTS.IDR).toBe(0);
  });

  it("accepts only supported ISO-4217 codes", () => {
    expect(isSupportedCurrency("IDR")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(false);
    expect(isIso4217Code("IDR")).toBe(true);
    expect(isIso4217Code("idr")).toBe(false);
    expect(isIso4217Code("RUPIAH")).toBe(false);
  });

  it("rejects non-integer and out-of-range amounts", () => {
    expect(isMinorUnitAmount(50_000)).toBe(true);
    expect(isMinorUnitAmount(-50_000)).toBe(true);
    expect(isMinorUnitAmount(50_000.5)).toBe(false);
    expect(isMinorUnitAmount(MAX_MINOR_UNIT_AMOUNT + 2)).toBe(false);
  });
});

describe("computePlatformFee", () => {
  it("splits gross into a proportional fee and the institution's net", () => {
    const result = computePlatformFee(1_000_000, terms({ basisPoints: 250 }));

    expect(result.platformFeeAmount).toBe(25_000);
    expect(result.institutionNetAmount).toBe(975_000);
    expect(result.platformFeeAmount + result.institutionNetAmount).toBe(result.grossAmount);
  });

  it("adds the flat component on top of the proportional one", () => {
    const result = computePlatformFee(100_000, terms({ basisPoints: 250, flatAmount: 5_000 }));

    expect(result.platformFeeAmount).toBe(2_500 + 5_000);
  });

  it("floors the proportional component, resolving fractions in the institution's favour", () => {
    // 33333 * 2.5% = 833.325 rupiah. Floor gives the platform 833 and the institution the rest;
    // ceiling would give the platform 834. The direction is the point, not the rupiah.
    const result = computePlatformFee(33_333, terms({ basisPoints: 250 }));

    expect(result.platformFeeAmount).toBe(833);
    expect(result.institutionNetAmount).toBe(32_500);
  });

  // A fraction ABOVE .5, where floor and round disagree. Without this the case above passes under
  // either operator, and the rounding DIRECTION — a stated design commitment, not an incidental
  // choice — could be reversed with the whole suite still green.
  it("floors rather than rounds when the fraction is above a half", () => {
    // 7 * 80% = 5.6 rupiah. Floor gives the platform 5; round would give it 6.
    const result = computePlatformFee(7, terms({ basisPoints: 8_000 }));

    expect(result.platformFeeAmount).toBe(5);
    expect(result.institutionNetAmount).toBe(2);
  });

  it("raises a fee below the configured minimum", () => {
    const result = computePlatformFee(100_000, terms({ basisPoints: 100, minimumFeeAmount: 5_000 }));

    expect(result.platformFeeAmount).toBe(5_000);
  });

  it("caps a fee above the configured maximum", () => {
    const result = computePlatformFee(
      10_000_000,
      terms({ basisPoints: 500, maximumFeeAmount: 100_000 }),
    );

    expect(result.platformFeeAmount).toBe(100_000);
  });

  it("never lets the fee exceed gross, so net can never go negative", () => {
    // A flat component larger than a small payment. Without the final clamp the institution would
    // owe money on a sale it made, and the DB split-balance CHECK would refuse the row.
    const result = computePlatformFee(1_000, terms({ flatAmount: 25_000 }));

    expect(result.platformFeeAmount).toBe(1_000);
    expect(result.institutionNetAmount).toBe(0);
  });

  it("handles a zero-gross payment without inventing a fee", () => {
    const result = computePlatformFee(0, terms({ basisPoints: 250, flatAmount: 5_000 }));

    expect(result.platformFeeAmount).toBe(0);
    expect(result.institutionNetAmount).toBe(0);
  });

  it("rejects a fractional gross amount", () => {
    expect(() => computePlatformFee(1_000.5, terms())).toThrow(FeeComputationError);
  });

  it("rejects basis points outside 0..10000", () => {
    expect(() => computePlatformFee(1_000, terms({ basisPoints: 10_001 }))).toThrow(
      FeeComputationError,
    );
    expect(() => computePlatformFee(1_000, terms({ basisPoints: -1 }))).toThrow(
      FeeComputationError,
    );
  });

  it("rejects a minimum larger than the maximum", () => {
    expect(() =>
      computePlatformFee(1_000, terms({ minimumFeeAmount: 900, maximumFeeAmount: 100 })),
    ).toThrow(FeeComputationError);
  });
});
