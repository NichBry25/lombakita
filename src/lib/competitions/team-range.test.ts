// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  FULL_TEAM_RANGE,
  isTeamRangeNarrowed,
  normalizeTeamRange,
  parseTeamBound,
  readTeamRange,
} from "./team-range";

describe("parseTeamBound", () => {
  it("reads whole numbers from 1 to 10 and nothing else", () => {
    expect(parseTeamBound("1")).toBe(1);
    expect(parseTeamBound("10")).toBe(10);
    expect(parseTeamBound("0")).toBeUndefined();
    expect(parseTeamBound("11")).toBeUndefined();
    expect(parseTeamBound("2.5")).toBeUndefined();
    expect(parseTeamBound("-2")).toBeUndefined();
    expect(parseTeamBound("abc")).toBeUndefined();
    expect(parseTeamBound("")).toBeUndefined();
    expect(parseTeamBound(undefined)).toBeUndefined();
  });
});

describe("normalizeTeamRange", () => {
  it("pulls a lower end above the upper end down to it", () => {
    expect(normalizeTeamRange({ min: 7, max: 3 })).toEqual({ min: 3, max: 3 });
    expect(normalizeTeamRange({ min: 2, max: 4 })).toEqual({ min: 2, max: 4 });
  });
});

describe("readTeamRange from teamMin and teamMax", () => {
  it("reads an absent end as the end of the track", () => {
    expect(readTeamRange({})).toEqual(FULL_TEAM_RANGE);
    expect(readTeamRange({ teamMin: "3" })).toEqual({ min: 3, max: 10 });
    expect(readTeamRange({ teamMax: "4" })).toEqual({ min: 1, max: 4 });
  });

  it("reads an unreadable end as the end of the track", () => {
    expect(readTeamRange({ teamMin: "abc", teamMax: "99" })).toEqual(FULL_TEAM_RANGE);
  });

  it("never lets the lower end pass the upper end", () => {
    expect(readTeamRange({ teamMin: "7", teamMax: "3" })).toEqual({ min: 3, max: 3 });
  });

  it("lets a range override the old parameters", () => {
    expect(readTeamRange({ mode: "individual", teamSize: "solo", teamMin: "5" })).toEqual({
      min: 5,
      max: 10,
    });
    expect(readTeamRange({ mode: "individual", teamMax: "6" })).toEqual({ min: 1, max: 6 });
  });
});

describe("readTeamRange from an old link", () => {
  it("turns mode into a range", () => {
    expect(readTeamRange({ mode: "individual" })).toEqual({ min: 1, max: 1 });
    expect(readTeamRange({ mode: "team" })).toEqual({ min: 2, max: 10 });
    expect(readTeamRange({ mode: "both" })).toEqual(FULL_TEAM_RANGE);
  });

  it("turns teamSize into a range", () => {
    expect(readTeamRange({ teamSize: "solo" })).toEqual({ min: 1, max: 1 });
    expect(readTeamRange({ teamSize: "small" })).toEqual({ min: 2, max: 4 });
    expect(readTeamRange({ teamSize: "large" })).toEqual({ min: 5, max: 10 });
  });

  it("takes the narrower overlap when both old parameters are present", () => {
    expect(readTeamRange({ mode: "team", teamSize: "small" })).toEqual({ min: 2, max: 4 });
    expect(readTeamRange({ mode: "team", teamSize: "large" })).toEqual({ min: 5, max: 10 });
    expect(readTeamRange({ mode: "individual", teamSize: "solo" })).toEqual({ min: 1, max: 1 });
    expect(readTeamRange({ mode: "both", teamSize: "small" })).toEqual({ min: 2, max: 4 });
  });

  it("ignores a word it does not know", () => {
    expect(readTeamRange({ mode: "online", teamSize: "huge" })).toEqual(FULL_TEAM_RANGE);
  });

  it("reads an old link whose range ends are unreadable the same as one with no range", () => {
    expect(readTeamRange({ mode: "team", teamMin: "abc", teamMax: "" })).toEqual({
      min: 2,
      max: 10,
    });
  });
});

describe("isTeamRangeNarrowed", () => {
  it("is false only for the whole track", () => {
    expect(isTeamRangeNarrowed(FULL_TEAM_RANGE)).toBe(false);
    expect(isTeamRangeNarrowed({ min: 2, max: 10 })).toBe(true);
    expect(isTeamRangeNarrowed({ min: 1, max: 9 })).toBe(true);
  });
});
