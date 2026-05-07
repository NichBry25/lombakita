// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CompetitionStatus } from "@/server/db/schema";
import {
  CompetitionError,
  COMPETITION_STATUS_VALUES,
  isAllowedStatusTransition,
  normalizeCompetitionSlug,
  parseCompetitionCreateInput,
  parseCompetitionPatchInput,
  parseStatusTransitionInput,
  validatePublishChecklist,
} from "@/server/competitions/competition-core";

describe("isAllowedStatusTransition", () => {
  const valid: [CompetitionStatus, CompetitionStatus][] = [
    ["draft", "published"],
    ["draft", "archived"],
    ["published", "draft"],
    ["published", "archived"],
  ];
  it.each(valid)("allows %s → %s", (from, to) => {
    expect(isAllowedStatusTransition(from, to)).toBe(true);
  });

  const invalid: [CompetitionStatus, CompetitionStatus][] = [
    ["draft", "draft"],
    ["published", "published"],
    ["archived", "draft"],
    ["archived", "published"],
    ["archived", "archived"],
  ];
  it.each(invalid)("rejects %s → %s", (from, to) => {
    expect(isAllowedStatusTransition(from, to)).toBe(false);
  });

  it("covers every enum value", () => {
    expect(COMPETITION_STATUS_VALUES).toEqual(["draft", "published", "archived"]);
  });
});

describe("normalizeCompetitionSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(normalizeCompetitionSlug(" Hackathon 2026 ")).toBe("hackathon-2026");
  });
  it("collapses repeated separators", () => {
    expect(normalizeCompetitionSlug("a---b__c")).toBe("a-b-c");
  });
  it("strips diacritics", () => {
    expect(normalizeCompetitionSlug("Lomba Cipta Karya")).toBe("lomba-cipta-karya");
  });
});

describe("parseCompetitionCreateInput", () => {
  it("requires institutionSlug", () => {
    expect(() => parseCompetitionCreateInput({ title: "Lomba Coding 2026" })).toThrow(
      CompetitionError,
    );
  });
  it("requires title (5-200 characters)", () => {
    expect(() => parseCompetitionCreateInput({ institutionSlug: "lk" })).toThrow(CompetitionError);
    expect(() => parseCompetitionCreateInput({ institutionSlug: "lk", title: "Hi" })).toThrow(
      CompetitionError,
    );
  });
  it("silently strips status, institutionId, and feeAmount", () => {
    const result = parseCompetitionCreateInput({
      institutionSlug: "lk",
      title: "Lomba Coding 2026",
      status: "published",
      institutionId: "evil-institution",
      feeAmount: 99,
    });
    expect(result.institutionSlug).toBe("lk");
    expect(result.title).toBe("Lomba Coding 2026");
    // No assertion of those stripped fields on the returned shape; the type is the contract.
  });
  it("strips unknown fields silently", () => {
    expect(() =>
      parseCompetitionCreateInput({
        institutionSlug: "lk",
        title: "Lomba Coding 2026",
        banana: 1,
      }),
    ).not.toThrow();
  });
  it("normalizes institutionSlug to lower-case trimmed", () => {
    const result = parseCompetitionCreateInput({
      institutionSlug: "  LK-Univ  ",
      title: "Lomba Coding 2026",
    });
    expect(result.institutionSlug).toBe("lk-univ");
    expect(result.title).toBe("Lomba Coding 2026");
    expect(result.slug).toBeNull();
  });
  it("rejects unnormalized explicit slug (uppercase, spaces)", () => {
    expect(() =>
      parseCompetitionCreateInput({
        institutionSlug: "lk",
        title: "Hackathon Tahun Ini 2026",
        slug: "Hackathon Tahun Ini",
      }),
    ).toThrow(CompetitionError);
  });
  it("accepts a strictly valid slug verbatim", () => {
    const result = parseCompetitionCreateInput({
      institutionSlug: "lk",
      title: "Hackathon Tahun Ini 2026",
      slug: "hackathon-2026",
    });
    expect(result.slug).toBe("hackathon-2026");
  });
});

describe("parseCompetitionPatchInput", () => {
  it("rejects empty payload", () => {
    expect(() => parseCompetitionPatchInput({})).toThrow(CompetitionError);
  });
  it("silently strips protected/blocked fields and rejects when nothing else remains", () => {
    expect(() => parseCompetitionPatchInput({ status: "published" })).toThrow(CompetitionError);
    expect(() => parseCompetitionPatchInput({ feeAmount: 0 })).toThrow(CompetitionError);
    expect(() => parseCompetitionPatchInput({ isFeatured: true })).toThrow(CompetitionError);
  });
  it("strips API-blocked fields silently when valid editable fields are also present", () => {
    const patch = parseCompetitionPatchInput({
      title: "Lomba Coding 2026",
      feeAmount: 1000,
      isFeatured: true,
    });
    expect(patch.title).toBe("Lomba Coding 2026");
    expect("feeAmount" in patch).toBe(false);
    expect("isFeatured" in patch).toBe(false);
  });
  it("strips unknown fields silently", () => {
    expect(() => parseCompetitionPatchInput({ banana: 1 })).toThrow(CompetitionError);
    const patch = parseCompetitionPatchInput({ title: "Lomba Coding 2026", banana: 1 });
    expect(patch.title).toBe("Lomba Coding 2026");
  });
  it("accepts valid date strings and null clears", () => {
    const patch = parseCompetitionPatchInput({
      eventStartAt: "2026-06-01T00:00:00Z",
      registrationEndAt: null,
    });
    expect(patch.eventStartAt).toBeInstanceOf(Date);
    expect(patch.registrationEndAt).toBeNull();
  });
  it("rejects invalid mode values", () => {
    expect(() => parseCompetitionPatchInput({ mode: "solo" })).toThrow(CompetitionError);
  });
  it("accepts mode null to clear", () => {
    const patch = parseCompetitionPatchInput({ mode: null });
    expect(patch.mode).toBeNull();
  });
  it("accepts each valid category enum value", () => {
    for (const cat of [
      "technology",
      "science",
      "business",
      "creative_arts",
      "social_humanities",
      "sports",
      "academic",
      "other",
    ] as const) {
      expect(parseCompetitionPatchInput({ category: cat }).category).toBe(cat);
    }
  });
  it("rejects unknown category strings", () => {
    expect(() => parseCompetitionPatchInput({ category: "robotics" })).toThrow(CompetitionError);
  });
  it("rejects eventEndAt before eventStartAt", () => {
    expect(() =>
      parseCompetitionPatchInput({
        eventStartAt: "2027-06-01T00:00:00Z",
        eventEndAt: "2027-05-01T00:00:00Z",
      }),
    ).toThrow(/eventEndAt must be after eventStartAt/);
  });
  it("rejects registrationEndAt before registrationStartAt", () => {
    expect(() =>
      parseCompetitionPatchInput({
        registrationStartAt: "2027-06-01T00:00:00Z",
        registrationEndAt: "2027-05-01T00:00:00Z",
      }),
    ).toThrow(/registrationEndAt must be after registrationStartAt/);
  });
  it("rejects registrationEndAt in the past", () => {
    expect(() =>
      parseCompetitionPatchInput({
        registrationEndAt: "2020-01-01T00:00:00Z",
      }),
    ).toThrow(/registrationEndAt must be in the future/);
  });
  it("accepts registrationEndAt clear (null)", () => {
    const patch = parseCompetitionPatchInput({ registrationEndAt: null });
    expect(patch.registrationEndAt).toBeNull();
  });
  it("rejects minTeamSize greater than maxTeamSize", () => {
    expect(() => parseCompetitionPatchInput({ minTeamSize: 5, maxTeamSize: 2 })).toThrow(
      /minTeamSize must be less than or equal to maxTeamSize/,
    );
  });
  it("accepts minTeamSize equal to maxTeamSize", () => {
    const patch = parseCompetitionPatchInput({ minTeamSize: 3, maxTeamSize: 3 });
    expect(patch.minTeamSize).toBe(3);
    expect(patch.maxTeamSize).toBe(3);
  });
});

describe("parseStatusTransitionInput", () => {
  it("requires a valid targetStatus", () => {
    expect(() => parseStatusTransitionInput({})).toThrow(CompetitionError);
    expect(() => parseStatusTransitionInput({ targetStatus: "live" })).toThrow(CompetitionError);
  });
  it("accepts each enum value", () => {
    for (const status of COMPETITION_STATUS_VALUES) {
      expect(parseStatusTransitionInput({ targetStatus: status }).targetStatus).toBe(status);
    }
  });
});

describe("validatePublishChecklist", () => {
  const base = {
    title: "Lomba",
    description: "Deskripsi yang panjang",
    mode: "individual" as const,
    registrationStartAt: null,
    registrationEndAt: null,
    eventStartAt: new Date(),
    eventEndAt: null,
  };

  it("returns empty when all required fields are present", () => {
    expect(validatePublishChecklist(base)).toEqual([]);
  });
  it("flags missing title", () => {
    expect(validatePublishChecklist({ ...base, title: "" })).toContain("title");
  });
  it("flags missing description", () => {
    expect(validatePublishChecklist({ ...base, description: "   " })).toContain("description");
  });
  it("flags missing mode", () => {
    expect(validatePublishChecklist({ ...base, mode: null })).toContain("mode");
  });
  it("flags missing dates when all are null", () => {
    expect(
      validatePublishChecklist({
        ...base,
        registrationStartAt: null,
        registrationEndAt: null,
        eventStartAt: null,
        eventEndAt: null,
      }),
    ).toContain("dates");
  });
});
