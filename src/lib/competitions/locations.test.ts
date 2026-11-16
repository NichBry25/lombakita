import { describe, expect, it } from "vitest";
import {
  COMPETITION_LOCATION_OPTIONS,
  getCompetitionLocationLabel,
  isCompetitionLocation,
  locationsMatchedByFilter,
} from "./locations";

describe("locationsMatchedByFilter", () => {
  it("shows hybrid under both online and offline, and hybrid alone under hybrid", () => {
    expect(locationsMatchedByFilter("online")).toEqual(["online", "hybrid"]);
    expect(locationsMatchedByFilter("offline")).toEqual(["offline", "hybrid"]);
    expect(locationsMatchedByFilter("hybrid")).toEqual(["hybrid"]);
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
