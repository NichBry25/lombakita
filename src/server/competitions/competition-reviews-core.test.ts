// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseCompetitionReviewInput,
  CompetitionReviewError,
} from "@/server/competitions/competition-reviews-core";

describe("parseCompetitionReviewInput", () => {
  it("parses a rating-only review", () => {
    expect(parseCompetitionReviewInput({ rating: 5 })).toEqual({ rating: 5, body: null });
  });

  it("parses a rating with a trimmed body", () => {
    expect(parseCompetitionReviewInput({ rating: 4, body: "  Bagus!  " })).toEqual({
      rating: 4,
      body: "Bagus!",
    });
  });

  it("coerces a blank body to null", () => {
    expect(parseCompetitionReviewInput({ rating: 3, body: "   " }).body).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(() => parseCompetitionReviewInput(null)).toThrow(CompetitionReviewError);
    expect(() => parseCompetitionReviewInput("x")).toThrow(/JSON object/);
  });

  it("rejects a missing or non-integer rating", () => {
    expect(() => parseCompetitionReviewInput({})).toThrow(/between 1 and 5/);
    expect(() => parseCompetitionReviewInput({ rating: 4.5 })).toThrow(/between 1 and 5/);
  });

  it("rejects a rating out of the 1–5 range", () => {
    expect(() => parseCompetitionReviewInput({ rating: 0 })).toThrow(/between 1 and 5/);
    expect(() => parseCompetitionReviewInput({ rating: 6 })).toThrow(/between 1 and 5/);
  });

  it("rejects a non-string body", () => {
    expect(() => parseCompetitionReviewInput({ rating: 5, body: 123 })).toThrow(
      /body must be a string/,
    );
  });

  it("rejects an over-long body", () => {
    expect(() => parseCompetitionReviewInput({ rating: 5, body: "x".repeat(2001) })).toThrow(
      /2000 characters/,
    );
  });
});
