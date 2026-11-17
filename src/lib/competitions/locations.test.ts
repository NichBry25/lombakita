import { describe, expect, it } from "vitest";
import { competitionLocationEnum } from "@/server/db/schema";
import {
  COMPETITION_LOCATION_LABELS,
  COMPETITION_LOCATION_OPTIONS,
  COMPETITION_LOCATION_VALUES,
  getCompetitionLocationLabel,
  isCompetitionLocation,
} from "./locations";

describe("the location value list", () => {
  it("holds exactly the values of the database enum, so a new enum value cannot be left out", () => {
    expect([...COMPETITION_LOCATION_VALUES].sort()).toEqual(
      [...competitionLocationEnum.enumValues].sort(),
    );
    expect(Object.keys(COMPETITION_LOCATION_LABELS).sort()).toEqual(
      [...competitionLocationEnum.enumValues].sort(),
    );
  });
});

describe("the location labels", () => {
  it("offers online, offline and hybrid with capitalized labels", () => {
    expect(COMPETITION_LOCATION_OPTIONS).toEqual([
      { value: "online", label: "Online" },
      { value: "offline", label: "Offline" },
      { value: "hybrid", label: "Hybrid" },
    ]);
  });

  it("labels only a known value", () => {
    expect(getCompetitionLocationLabel("hybrid")).toBe("Hybrid");
    expect(getCompetitionLocationLabel("mars")).toBe("");
    expect(getCompetitionLocationLabel(null)).toBe("");
    expect(isCompetitionLocation("Online")).toBe(false);
  });
});
