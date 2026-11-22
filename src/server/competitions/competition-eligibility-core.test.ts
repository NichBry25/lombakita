// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseEligibilityAudience,
  parseEligibilityNote,
  CompetitionEligibilityInputError,
} from "@/server/competitions/competition-eligibility-service";

describe("parseEligibilityAudience", () => {
  it("is undefined when the payload has no audience key, so the stored audience stays", () => {
    expect(parseEligibilityAudience({ eligibilityNote: "x" })).toBeUndefined();
    expect(parseEligibilityAudience({})).toBeUndefined();
  });

  it("is null for null and for an empty list, never an empty array", () => {
    expect(parseEligibilityAudience({ audience: null })).toBeNull();
    expect(parseEligibilityAudience({ audience: [] })).toBeNull();
  });

  it("puts the values in the fixed order and drops duplicates", () => {
    expect(parseEligibilityAudience({ audience: ["sd", "umum", "sd", "smp"] })).toEqual([
      "umum",
      "smp",
      "sd",
    ]);
  });

  it("rejects an unknown value, a non-list and a non-object payload", () => {
    expect(() => parseEligibilityAudience({ audience: ["umum", "dosen"] })).toThrow(
      CompetitionEligibilityInputError,
    );
    expect(() => parseEligibilityAudience({ audience: "umum" })).toThrow(/known audience values/);
    expect(() => parseEligibilityAudience(null)).toThrow(/JSON object/);
  });
});

describe("parseEligibilityNote", () => {
  it("trims and returns a note", () => {
    expect(parseEligibilityNote({ eligibilityNote: "  Terbuka untuk mahasiswa.  " })).toBe(
      "Terbuka untuk mahasiswa.",
    );
  });

  it("returns null for blank, null, or missing", () => {
    expect(parseEligibilityNote({ eligibilityNote: "   " })).toBeNull();
    expect(parseEligibilityNote({ eligibilityNote: null })).toBeNull();
    expect(parseEligibilityNote({})).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(() => parseEligibilityNote(null)).toThrow(CompetitionEligibilityInputError);
    expect(() => parseEligibilityNote("x")).toThrow(/JSON object/);
  });

  it("rejects a non-string note", () => {
    expect(() => parseEligibilityNote({ eligibilityNote: 42 })).toThrow(/string or null/);
  });

  it("rejects an over-long note", () => {
    expect(() => parseEligibilityNote({ eligibilityNote: "x".repeat(2001) })).toThrow(
      /2000 characters/,
    );
  });
});
