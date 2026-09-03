// @vitest-environment node

// A REPEATED QUERY PARAMETER ARRIVES AS AN ARRAY.
//
// `?q=a&q=b` gives Next `{ q: ["a", "b"] }`, and the listing page declared its params as plain
// strings. That compiled, so nothing objected until the array reached `filters.q?.trim()` in the
// listing service and the public page answered HTTP 500 — on the one surface this step exists to
// make readable by crawlers, which are exactly the callers that follow a malformed link.
//
// The sibling path never had the defect: `/api/v1/competitions` reads through
// `URLSearchParams.get`, which returns the first value and drops the rest. These tests pin the page
// to that same behaviour, so the two paths cannot answer a repeated parameter differently again.

import { describe, expect, it } from "vitest";
import { readCompetitionSearchParams } from "./search-params";

describe("readCompetitionSearchParams", () => {
  it("takes the first value of every repeated parameter, as URLSearchParams.get does", () => {
    const narrowed = readCompetitionSearchParams({
      q: ["a", "b"],
      category: ["hackathon", "essay"],
      mode: ["online", "offline"],
      status: ["all", "open"],
      teamSize: ["solo", "small"],
      sort: ["deadline_asc", "created_desc"],
      page: ["2", "9"],
    });

    expect(narrowed).toEqual({
      q: "a",
      category: "hackathon",
      mode: "online",
      status: "all",
      teamSize: "solo",
      sort: "deadline_asc",
      page: "2",
    });
  });

  it("leaves a plain scalar untouched", () => {
    expect(readCompetitionSearchParams({ q: "hackathon", page: "3" })).toMatchObject({
      q: "hackathon",
      page: "3",
    });
  });

  it("returns undefined for an absent parameter and for an empty repetition", () => {
    const narrowed = readCompetitionSearchParams({ q: [] });

    expect(narrowed.q).toBeUndefined();
    expect(narrowed.category).toBeUndefined();
  });

  it("yields values a string consumer can call string methods on", () => {
    // The actual crash, reproduced at the boundary that now prevents it: the listing service calls
    // `.trim()` on `q`. An array has no `.trim`, so this is the assertion that would have caught
    // the 500 before it shipped.
    const { q } = readCompetitionSearchParams({ q: ["  hackathon  ", "b"] });

    expect(() => q?.trim()).not.toThrow();
    expect(q?.trim()).toBe("hackathon");
  });

  it("ignores query parameters the listing does not read", () => {
    const narrowed = readCompetitionSearchParams({ utm_source: "x", q: "y" });

    expect(narrowed).not.toHaveProperty("utm_source");
    expect(narrowed.q).toBe("y");
  });
});
