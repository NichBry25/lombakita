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
  CLEAR_FEE_PARAMS,
  DEFAULT_FILTER_SELECTION,
  competitionsHref,
  competitionsQuery,
  describeFeeAmount,
  describeFeeValue,
  describeFeeRange,
  describeTeamRange,
  describeTeamSizeForSpeech,
  feeFilterToParams,
  readCompetitionSearchParams,
  readFilterSelection,
  selectionToParams,
  teamRangeToParams,
} from "./search-params";

// formatRupiah separates "Rp" from the digits with a no-break space.
const rupiah = (digits: string): string => `Rp ${digits}`;

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
      fee: ["paid", "free"],
      feeMin: ["25000", "50000"],
      feeMax: ["100000", "150000"],
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
      fee: "paid",
      feeMin: "25000",
      feeMax: "100000",
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

  it("says Individu in place of 1 at the start of a range", () => {
    expect(describeTeamRange({ min: 1, max: 1 })).toBe("Individu");
    expect(describeTeamRange({ min: 1, max: 5 })).toBe("Individu sampai 5");
    expect(describeTeamRange({ min: 1, max: 10 })).toBe("Individu sampai 10+");
    expect(describeTeamRange({ min: 2, max: 4 })).toBe("2 sampai 4");
    expect(describeTeamRange({ min: 2, max: 5 })).toBe("2 sampai 5");
  });

  it("says Individu for a handle on 1 and keeps the other numbers for speech", () => {
    expect(describeTeamSizeForSpeech(1)).toBe("Individu");
    expect(describeTeamSizeForSpeech(2)).toBe("2");
    expect(describeTeamSizeForSpeech(10)).toBe("10 atau lebih");
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

describe("the words of the fee filter", () => {
  it("writes an amount with formatRupiah and the top of the track as Rp 250.000+", () => {
    expect(describeFeeAmount(0)).toBe(rupiah("0"));
    expect(describeFeeAmount(25_000)).toBe(rupiah("25.000"));
    expect(describeFeeAmount(250_000)).toBe(`${rupiah("250.000")}+`);
  });

  it("describes the slider's range with sampai", () => {
    expect(describeFeeRange({ min: 25_000, max: 250_000 })).toBe(
      `${rupiah("25.000")} sampai ${rupiah("250.000")}+`,
    );
    expect(describeFeeRange({ min: 0, max: 250_000 })).toBe(
      `${rupiah("0")} sampai ${rupiah("250.000")}+`,
    );
  });

  it.each([
    [{ kind: "any" } as const, undefined],
    [{ kind: "free" } as const, "Gratis"],
    [{ kind: "paid", min: 0, max: 250_000 } as const, "Berbayar"],
    [
      { kind: "paid", min: 25_000, max: 100_000 } as const,
      `${rupiah("25.000")} sampai ${rupiah("100.000")}`,
    ],
    [{ kind: "paid", min: 50_000, max: 250_000 } as const, `mulai ${rupiah("50.000")}`],
    [{ kind: "paid", min: 0, max: 100_000 } as const, `sampai ${rupiah("100.000")}`],
  ])("words %j as %s", (fee, words) => {
    expect(describeFeeValue(fee)).toBe(words);
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
      fee: { kind: "any" },
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
      fee: undefined,
      feeMin: undefined,
      feeMax: undefined,
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

  it("carries the fee and its two ends through a search", () => {
    expect(CARRIED_FILTERS).toEqual(expect.arrayContaining(["fee", "feeMin", "feeMax"]));
  });

  it("reads the fee filter from the address, and nothing from a stray end", () => {
    expect(readFilterSelection({ fee: "free" }).fee).toEqual({ kind: "free" });
    expect(readFilterSelection({ fee: "paid", feeMin: "50000", feeMax: "100000" }).fee).toEqual({
      kind: "paid",
      min: 50_000,
      max: 100_000,
    });
    expect(readFilterSelection({ feeMin: "50000" }).fee).toEqual({ kind: "any" });
    expect(readFilterSelection({ fee: "free", feeMin: "50000" }).fee).toEqual({ kind: "free" });
  });

  it("writes the fee into the address, leaving an end at the end of the track out", () => {
    const withFee = (fee: Parameters<typeof feeFilterToParams>[0]) =>
      selectionToParams({ ...DEFAULT_FILTER_SELECTION, fee });

    expect(withFee({ kind: "free" })).toMatchObject({
      fee: "free",
      feeMin: undefined,
      feeMax: undefined,
    });
    expect(withFee({ kind: "paid", min: 0, max: 250_000 })).toMatchObject({
      fee: "paid",
      feeMin: undefined,
      feeMax: undefined,
    });
    expect(withFee({ kind: "paid", min: 25_000, max: 100_000 })).toMatchObject({
      fee: "paid",
      feeMin: "25000",
      feeMax: "100000",
    });
    expect(feeFilterToParams({ kind: "any" })).toEqual(CLEAR_FEE_PARAMS);
  });

  it("drops the ends of a paid range when Gratis or no fee is chosen", () => {
    const stale = { fee: "paid", feeMin: "25000", feeMax: "100000" };

    const freeHref = competitionsHref(stale, feeFilterToParams({ kind: "free" }));
    const anyHref = competitionsHref(stale, feeFilterToParams({ kind: "any" }));

    expect(freeHref).toBe("/competitions?fee=free");
    expect(anyHref).toBe("/competitions");
  });

  it("leaves every filter out of the address when nothing is chosen", () => {
    const href = competitionsHref(
      { mode: "team", teamSize: "small" },
      selectionToParams(DEFAULT_FILTER_SELECTION),
    );

    expect(href).toBe("/competitions?sort=created_desc");
  });
});
