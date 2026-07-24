// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseEligibilityNote,
  CompetitionEligibilityInputError,
} from "@/server/competitions/competition-eligibility-service";

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
