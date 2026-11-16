// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  FULL_FEE_RANGE,
  isFeeRangeNarrowed,
  normalizeFeeRange,
  parseFeeMax,
  parseFeeMin,
  readFeeFilter,
} from "./fee-range";

describe("parseFeeMin", () => {
  it("reads whole rupiah from 0 to 250000 on steps of 25000 and nothing else", () => {
    expect(parseFeeMin("0")).toBe(0);
    expect(parseFeeMin("25000")).toBe(25_000);
    expect(parseFeeMin("250000")).toBe(250_000);
    expect(parseFeeMin("12345")).toBeUndefined();
    expect(parseFeeMin("275000")).toBeUndefined();
    expect(parseFeeMin("-25000")).toBeUndefined();
    expect(parseFeeMin("25000.5")).toBeUndefined();
    expect(parseFeeMin("abc")).toBeUndefined();
    expect(parseFeeMin("")).toBeUndefined();
    expect(parseFeeMin(undefined)).toBeUndefined();
  });

  it("ignores a value too long to be a safe integer", () => {
    expect(parseFeeMin("9".repeat(400))).toBeUndefined();
    expect(parseFeeMin("9007199254740992")).toBeUndefined();
  });
});

describe("parseFeeMax", () => {
  it("reads from 25000 to 250000 on steps of 25000, so 0 is read as an open end", () => {
    expect(parseFeeMax("0")).toBeUndefined();
    expect(parseFeeMax("25000")).toBe(25_000);
    expect(parseFeeMax("250000")).toBe(250_000);
    expect(parseFeeMax("30000")).toBeUndefined();
    expect(parseFeeMax("300000")).toBeUndefined();
    expect(parseFeeMax("x")).toBeUndefined();
    expect(parseFeeMax(undefined)).toBeUndefined();
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
  });
});

describe("readFeeFilter", () => {
  it("asks for nothing without fee, with an unknown fee, or with fee in another case", () => {
    expect(readFeeFilter({})).toEqual({ kind: "any" });
    expect(readFeeFilter({ fee: "both" })).toEqual({ kind: "any" });
    expect(readFeeFilter({ fee: "FREE" })).toEqual({ kind: "any" });
    expect(readFeeFilter({ fee: "" })).toEqual({ kind: "any" });
  });

  it("reads free, and ignores the two ends beside it", () => {
    expect(readFeeFilter({ fee: "free" })).toEqual({ kind: "free" });
    expect(readFeeFilter({ fee: "free", feeMin: "25000", feeMax: "100000" })).toEqual({
      kind: "free",
    });
  });

  it("ignores feeMin and feeMax without fee=paid", () => {
    expect(readFeeFilter({ feeMin: "25000" })).toEqual({ kind: "any" });
    expect(readFeeFilter({ feeMax: "100000" })).toEqual({ kind: "any" });
    expect(readFeeFilter({ fee: "both", feeMin: "25000", feeMax: "100000" })).toEqual({
      kind: "any",
    });
  });

  it("reads paid with an absent end as the end of the track", () => {
    expect(readFeeFilter({ fee: "paid" })).toEqual({ kind: "paid", min: 0, max: 250_000 });
    expect(readFeeFilter({ fee: "paid", feeMin: "50000" })).toEqual({
      kind: "paid",
      min: 50_000,
      max: 250_000,
    });
    expect(readFeeFilter({ fee: "paid", feeMax: "100000" })).toEqual({
      kind: "paid",
      min: 0,
      max: 100_000,
    });
  });

  it("reads an off-step, a 0 upper end or an unreadable end as the end of the track", () => {
    expect(readFeeFilter({ fee: "paid", feeMin: "30000", feeMax: "0" })).toEqual({
      kind: "paid",
      min: 0,
      max: 250_000,
    });
    expect(readFeeFilter({ fee: "paid", feeMin: "abc", feeMax: "999999999" })).toEqual({
      kind: "paid",
      min: 0,
      max: 250_000,
    });
  });

  it("never lets the lower end pass the upper end", () => {
    expect(readFeeFilter({ fee: "paid", feeMin: "200000", feeMax: "100000" })).toEqual({
      kind: "paid",
      min: 100_000,
      max: 100_000,
    });
  });
});
