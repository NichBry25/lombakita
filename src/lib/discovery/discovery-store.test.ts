// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  RECENTLY_VIEWED_LIMIT,
  parseInterests,
  parseRecentlyViewed,
  recordRecentlyViewed,
  toggleInterest,
  type RecentlyViewedItem,
} from "./discovery-store";

const item = (n: number): RecentlyViewedItem => ({
  id: `comp_${n}`,
  slug: `kompetisi-${n}`,
  institutionSlug: "ui",
  title: `Kompetisi ${n}`,
  institutionName: "Universitas Indonesia",
  category: "hackathon",
  registrationEndAt: "2026-12-01T00:00:00.000Z",
});

const storedRecent = () =>
  parseRecentlyViewed(window.localStorage.getItem("lombakita-recently-viewed"));
const storedInterests = () => parseInterests(window.localStorage.getItem("lombakita-interests"));

describe("discovery store", () => {
  afterEach(() => window.localStorage.clear());

  it("keeps only known categories, once each", () => {
    expect(parseInterests(JSON.stringify(["hackathon", "not_a_category", "hackathon", 4]))).toEqual(
      ["hackathon"],
    );
  });

  it("treats unreadable stored text as nothing stored", () => {
    expect(parseInterests("{broken")).toEqual([]);
    expect(parseInterests(JSON.stringify({ hackathon: true }))).toEqual([]);
    expect(parseRecentlyViewed(null)).toEqual([]);
  });

  it("drops recently viewed entries that are missing fields", () => {
    const missingTitle: Partial<RecentlyViewedItem> = { ...item(2) };
    delete missingTitle.title;
    expect(parseRecentlyViewed(JSON.stringify([item(1), missingTitle]))).toEqual([item(1)]);
  });

  it("toggles an interest on and off", () => {
    toggleInterest("business");
    toggleInterest("design");
    expect(storedInterests()).toEqual(["business", "design"]);

    toggleInterest("business");
    expect(storedInterests()).toEqual(["design"]);
  });

  it("puts the latest view first and moves a repeat view back to the front", () => {
    recordRecentlyViewed(item(1));
    recordRecentlyViewed(item(2));
    recordRecentlyViewed(item(1));

    expect(storedRecent().map((entry) => entry.id)).toEqual(["comp_1", "comp_2"]);
  });

  it(`remembers at most ${RECENTLY_VIEWED_LIMIT} competitions`, () => {
    for (let n = 1; n <= RECENTLY_VIEWED_LIMIT + 3; n += 1) recordRecentlyViewed(item(n));

    const recent = storedRecent();
    expect(recent).toHaveLength(RECENTLY_VIEWED_LIMIT);
    expect(recent[0]?.id).toBe(`comp_${RECENTLY_VIEWED_LIMIT + 3}`);
  });
});
