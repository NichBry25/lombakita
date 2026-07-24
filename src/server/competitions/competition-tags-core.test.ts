// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseCompetitionTagsInput,
  CompetitionTagsInputError,
} from "@/server/competitions/competition-tags-core";

describe("parseCompetitionTagsInput", () => {
  it("accepts allowed tags and dedupes", () => {
    expect(parseCompetitionTagsInput({ tags: ["Bisnis", "Hackathon", "Bisnis"] })).toEqual([
      "Bisnis",
      "Hackathon",
    ]);
  });

  it("accepts an empty tag list", () => {
    expect(parseCompetitionTagsInput({ tags: [] })).toEqual([]);
  });

  it("rejects a payload without a tags array", () => {
    expect(() => parseCompetitionTagsInput({})).toThrow(CompetitionTagsInputError);
    expect(() => parseCompetitionTagsInput({ tags: "Bisnis" })).toThrow(/must be an array/);
  });

  it("rejects a tag outside the controlled vocabulary", () => {
    expect(() => parseCompetitionTagsInput({ tags: ["Bisnis", "NotARealTag"] })).toThrow(
      /allowed values/,
    );
  });

  it("rejects a non-string tag", () => {
    expect(() => parseCompetitionTagsInput({ tags: [123] })).toThrow(/allowed values/);
  });
});
