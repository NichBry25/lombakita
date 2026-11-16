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
import {
  CARRIED_FILTERS,
  DEFAULT_FILTER_SELECTION,
  competitionsHref,
  competitionsQuery,
  describeTeamRange,
  readCompetitionSearchParams,
  readFilterSelection,
  selectionToParams,
  teamRangeToParams,
} from "./search-params";

describe("readCompetitionSearchParams", () => {
  it("takes the first value of every repeated parameter, as URLSearchParams.get does", () => {
    const narrowed = readCompetitionSearchParams({
      q: ["a", "b"],
      category: ["hackathon", "essay"],
      mode: ["online", "offline"],
      status: ["all", "open"],
      teamSize: ["solo", "small"],
      teamMin: ["2", "3"],
      teamMax: ["4", "5"],
      location: ["online", "offline"],
      audience: ["mahasiswa,smp", "sd"],
      sort: ["deadline_asc", "created_desc"],
      page: ["2", "9"],
    });

    expect(narrowed).toEqual({
      q: "a",
      category: "hackathon",
      mode: "online",
      status: "all",
      teamSize: "solo",
      teamMin: "2",
      teamMax: "4",
      location: "online",
      audience: "mahasiswa,smp",
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

describe("the team size range in the address", () => {
  it("writes both ends for a range inside the track and leaves an end on the track end out", () => {
    expect(teamRangeToParams({ min: 2, max: 4 })).toEqual({ teamMin: "2", teamMax: "4" });
    expect(teamRangeToParams({ min: 2, max: 10 })).toEqual({
      teamMin: "2",
      teamMax: undefined,
    });
    expect(teamRangeToParams({ min: 1, max: 1 })).toEqual({
      teamMin: undefined,
      teamMax: "1",
    });
    expect(teamRangeToParams({ min: 1, max: 10 })).toEqual({
      teamMin: undefined,
      teamMax: undefined,
    });
  });

  it("says Individu when both ends sit on 1", () => {
    expect(describeTeamRange({ min: 1, max: 1 })).toBe("Individu");
    expect(describeTeamRange({ min: 1, max: 10 })).toBe("1 sampai 10+");
    expect(describeTeamRange({ min: 2, max: 4 })).toBe("2 sampai 4");
  });

  it("is carried through a search and into a link", () => {
    expect(CARRIED_FILTERS).toContain("teamMin");
    expect(CARRIED_FILTERS).toContain("teamMax");
    expect(CARRIED_FILTERS).toContain("mode");
    expect(CARRIED_FILTERS).toContain("teamSize");
    expect(competitionsHref({ teamMin: "2", teamMax: "4" }, { page: "3" })).toBe(
      "/competitions?teamMin=2&teamMax=4&page=3",
    );
  });
});

describe("competitionsQuery", () => {
  it("has no leading question mark and drops what an override clears", () => {
    expect(competitionsQuery({ q: "a", category: "x" }, { category: undefined })).toBe("q=a");
    expect(competitionsQuery({})).toBe("");
  });
});

describe("a filter selection", () => {
  it("reads the defaults from an empty address", () => {
    expect(readFilterSelection({})).toEqual(DEFAULT_FILTER_SELECTION);
  });

  it("reads an old mode or teamSize link as the range it stands for", () => {
    expect(readFilterSelection({ mode: "team" }).teamRange).toEqual({ min: 2, max: 10 });
    expect(readFilterSelection({ teamSize: "small" }).teamRange).toEqual({ min: 2, max: 4 });
  });

  it("becomes address parameters, and a team range replaces an old mode and teamSize word", () => {
    const params = selectionToParams({
      category: "debat",
      status: "open",
      sort: "deadline_asc",
      teamRange: { min: 2, max: 4 },
      location: "online",
      audience: ["mahasiswa", "smp"],
    });

    expect(params).toEqual({
      category: "debat",
      status: "open",
      sort: "deadline_asc",
      location: "online",
      audience: "mahasiswa,smp",
      mode: undefined,
      teamSize: undefined,
      teamMin: "2",
      teamMax: "4",
    });
  });

  it("reads a location and an audience from the address, keeping only the known ones", () => {
    expect(readFilterSelection({ location: "hybrid", audience: "smp,mahasiswa" })).toMatchObject({
      location: "hybrid",
      audience: ["mahasiswa", "smp"],
    });
    expect(readFilterSelection({ location: "mars", audience: "umum,mars" })).toMatchObject({
      location: "",
      audience: [],
    });
  });

  it("carries the location and the audience through a search", () => {
    expect(CARRIED_FILTERS).toEqual(expect.arrayContaining(["location", "audience"]));
  });

  it("leaves every filter out of the address when nothing is chosen", () => {
    const href = competitionsHref(
      { mode: "team", teamSize: "small" },
      selectionToParams(DEFAULT_FILTER_SELECTION),
    );

    expect(href).toBe("/competitions?sort=created_desc");
  });
});
