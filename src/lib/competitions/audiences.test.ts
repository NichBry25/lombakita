import { describe, expect, it } from "vitest";
import { competitionAudienceEnum } from "@/server/db/schema";
import {
  COMPETITION_AUDIENCE_LABELS,
  COMPETITION_AUDIENCE_VALUES,
  audienceFilterLevels,
  formatAudienceLabels,
  isCompetitionAudience,
  normalizeAudience,
  parseAudienceFilterParam,
} from "./audiences";

describe("the audience value list", () => {
  it("holds exactly the values of the database enum, so a new enum value cannot be left out", () => {
    expect([...COMPETITION_AUDIENCE_VALUES].sort()).toEqual(
      [...competitionAudienceEnum.enumValues].sort(),
    );
    expect(Object.keys(COMPETITION_AUDIENCE_LABELS).sort()).toEqual(
      [...competitionAudienceEnum.enumValues].sort(),
    );
  });
});

describe("normalizeAudience", () => {
  it("puts the values in the fixed order and drops duplicates", () => {
    expect(normalizeAudience(["sd", "umum", "sd", "mahasiswa"])).toEqual([
      "umum",
      "mahasiswa",
      "sd",
    ]);
  });

  it("turns an empty list into null, never an empty array", () => {
    expect(normalizeAudience([])).toBeNull();
  });
});

describe("formatAudienceLabels", () => {
  it("joins the labels in the fixed order", () => {
    expect(formatAudienceLabels(["sd", "sma_smk", "umum", "mahasiswa", "smp"])).toBe(
      "Umum, Mahasiswa, SMA/SMK, SMP, SD",
    );
  });

  it("says nothing for an empty audience", () => {
    expect(formatAudienceLabels(null)).toBe("");
    expect(formatAudienceLabels([])).toBe("");
  });
});

describe("the audience filter", () => {
  it("leaves umum out, because umum is always included", () => {
    expect(audienceFilterLevels(["umum", "smp"])).toEqual(["smp"]);
    expect(audienceFilterLevels(["umum"])).toEqual([]);
  });

  it("drops unknown values", () => {
    expect(audienceFilterLevels(["dosen", "mahasiswa", ""])).toEqual(["mahasiswa"]);
    expect(isCompetitionAudience("dosen")).toBe(false);
    expect(isCompetitionAudience(undefined)).toBe(false);
  });

  it("reads a comma separated address parameter in the fixed order", () => {
    expect(parseAudienceFilterParam("smp,mahasiswa, smp")).toEqual(["mahasiswa", "smp"]);
    expect(parseAudienceFilterParam("umum")).toEqual([]);
    expect(parseAudienceFilterParam("mars,,")).toEqual([]);
    expect(parseAudienceFilterParam("")).toEqual([]);
    expect(parseAudienceFilterParam(undefined)).toEqual([]);
  });
});
