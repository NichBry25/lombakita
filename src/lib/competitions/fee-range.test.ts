// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  FULL_FEE_RANGE,
  isFeeRangeNarrowed,
  normalizeFeeRange,
  parseFeeBound,
  readFeeRange,
} from "./fee-range";

describe("parseFeeBound", () => {
  it("reads whole rupiah from 0 to 250000 on steps of 25000 and nothing else", () => {
    expect(parseFeeBound("0")).toBe(0);
    expect(parseFeeBound("25000")).toBe(25_000);
    expect(parseFeeBound("250000")).toBe(250_000);
    expect(parseFeeBound("12345")).toBeUndefined();
    expect(parseFeeBound("275000")).toBeUndefined();
    expect(parseFeeBound("-25000")).toBeUndefined();
    expect(parseFeeBound("25000.5")).toBeUndefined();
    expect(parseFeeBound("abc")).toBeUndefined();
    expect(parseFeeBound("")).toBeUndefined();
    expect(parseFeeBound(undefined)).toBeUndefined();
  });

  it("ignores a value too long to be a safe integer", () => {
    expect(parseFeeBound("9".repeat(400))).toBeUndefined();
    expect(parseFeeBound("9007199254740992")).toBeUndefined();
  });
});

describe("normalizeFeeRange", () => {
  it("pulls a lower end above the upper end down to it", () => {
    expect(normalizeFeeRange({ min: 200_000, max: 100_000 })).toEqual({
      min: 100_000,
      max: 100_000,
    });
    expect(normalizeFeeRange({ min: 25_000, max: 100_000 })).toEqual({
      min: 25_000,
      max: 100_000,
    });
  });
});

describe("isFeeRangeNarrowed", () => {
  it("is false only for the whole track", () => {
    expect(isFeeRangeNarrowed(FULL_FEE_RANGE)).toBe(false);
    expect(isFeeRangeNarrowed({ min: 25_000, max: 250_000 })).toBe(true);
    expect(isFeeRangeNarrowed({ min: 0, max: 225_000 })).toBe(true);
    expect(isFeeRangeNarrowed({ min: 0, max: 0 })).toBe(true);
  });
});

describe("readFeeRange", () => {
  it("reads the whole track from an address with neither end", () => {
    expect(readFeeRange({})).toEqual({ min: 0, max: 250_000 });
  });

  it("reads an absent end as the end of the track", () => {
    expect(readFeeRange({ feeMin: "50000" })).toEqual({ min: 50_000, max: 250_000 });
    expect(readFeeRange({ feeMax: "100000" })).toEqual({ min: 0, max: 100_000 });
  });

  it("reads a 0 upper end as Gratis to Gratis", () => {
    expect(readFeeRange({ feeMax: "0" })).toEqual({ min: 0, max: 0 });
  });

  it("reads an off-step, out-of-range or unreadable end as the end of the track", () => {
    expect(readFeeRange({ feeMin: "30000", feeMax: "300000" })).toEqual({ min: 0, max: 250_000 });
    expect(readFeeRange({ feeMin: "abc", feeMax: "999999999" })).toEqual({ min: 0, max: 250_000 });
  });

  it("never lets the lower end pass the upper end", () => {
    expect(readFeeRange({ feeMin: "200000", feeMax: "100000" })).toEqual({
      min: 100_000,
      max: 100_000,
    });
  });
});
