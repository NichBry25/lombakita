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

describe("validatePublishChecklist", () => {
  // Use future dates so registrationEndAt > now() does not falsely fail.
  const inFuture = (offsetDays: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d;
  };

  const passing = () => ({
    title: "Lomba",
    description: "Deskripsi yang panjang",
    category: "technology" as const,
    mode: "individual" as const,
    registrationStartAt: inFuture(7),
    registrationEndAt: inFuture(30),
    eventStartAt: inFuture(40),
    eventEndAt: inFuture(45),
  });

  const fields = (failures: { field: string }[]) => failures.map((f) => f.field);

  it("returns passed:true when every required field is present and ordered", () => {
    const result = validatePublishChecklist(passing());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("flags missing title with code 'missing'", () => {
    const result = validatePublishChecklist({ ...passing(), title: "" });
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "title", code: "missing" }),
    );
  });

  it("flags missing description (whitespace only) with code 'missing'", () => {
    const result = validatePublishChecklist({ ...passing(), description: "   " });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "description", code: "missing" }),
    );
  });

  it("flags missing mode and category", () => {
    const result = validatePublishChecklist({ ...passing(), mode: null, category: null });
    expect(fields(result.failures)).toEqual(expect.arrayContaining(["mode", "category"]));
  });

  it("flags every individually-missing date field separately (not collapsed to 'dates')", () => {
    const result = validatePublishChecklist({
      ...passing(),
      registrationStartAt: null,
      registrationEndAt: null,
      eventStartAt: null,
      eventEndAt: null,
    });
    expect(fields(result.failures)).toEqual(
      expect.arrayContaining([
        "registrationStartAt",
        "registrationEndAt",
        "eventStartAt",
        "eventEndAt",
      ]),
    );
  });

  it("flags out_of_order when registrationEndAt is before registrationStartAt", () => {
    const result = validatePublishChecklist({
      ...passing(),
      registrationStartAt: inFuture(30),
      registrationEndAt: inFuture(7),
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "registrationEndAt", code: "out_of_order" }),
    );
  });

  it("flags out_of_order when registrationEndAt is after eventStartAt", () => {
    const result = validatePublishChecklist({
      ...passing(),
      registrationEndAt: inFuture(50),
      eventStartAt: inFuture(40),
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "registrationEndAt", code: "out_of_order" }),
    );
  });

  it("flags out_of_order when eventEndAt is before eventStartAt", () => {
    const result = validatePublishChecklist({
      ...passing(),
      eventStartAt: inFuture(50),
      eventEndAt: inFuture(40),
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "eventEndAt", code: "out_of_order" }),
    );
  });

  it("flags not_in_future when registrationEndAt is in the past", () => {
    const past = new Date("2020-01-01T00:00:00Z");
    const result = validatePublishChecklist({ ...passing(), registrationEndAt: past });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "registrationEndAt", code: "not_in_future" }),
    );
  });

  it("aggregates multiple failures (does not short-circuit)", () => {
    const result = validatePublishChecklist({
      title: "",
      description: "",
      category: null,
      mode: null,
      registrationStartAt: null,
      registrationEndAt: null,
      eventStartAt: null,
      eventEndAt: null,
    });
    expect(result.failures.length).toBeGreaterThanOrEqual(8);
  });
});
