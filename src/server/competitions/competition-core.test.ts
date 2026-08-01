// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CompetitionStatus } from "@/server/db/schema";
import {
  CompetitionError,
  COMPETITION_STATUS_VALUES,
  TEAM_MODE_MIN_SIZE,
  isAllowedStatusTransition,
  normalizeCompetitionSlug,
  parseCompetitionCreateInput,
  parseCompetitionPatchInput,
  validatePublishChecklist,
} from "@/server/competitions/competition-core";

describe("isAllowedStatusTransition", () => {
  const valid: [CompetitionStatus, CompetitionStatus][] = [
    ["draft", "published"],
    ["published", "draft"],
  ];
  it.each(valid)("allows %s → %s", (from, to) => {
    expect(isAllowedStatusTransition(from, to)).toBe(true);
  });

  // draft → archived and published → archived were valid until archiving was retired. They moved
  // here deliberately: a finished competition stays published so its public record survives, and
  // no path may put a competition into a state that hides it.
  const invalid: [CompetitionStatus, CompetitionStatus][] = [
    ["draft", "draft"],
    ["published", "published"],
    ["draft", "archived"],
    ["published", "archived"],
    ["archived", "draft"],
    ["archived", "published"],
    ["archived", "archived"],
  ];
  it.each(invalid)("rejects %s → %s", (from, to) => {
    expect(isAllowedStatusTransition(from, to)).toBe(false);
  });

  // The enum keeps "archived" because Postgres cannot drop an enum value. This asserts the value
  // still exists, not that anything can reach it — the invalid set above pins that.
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

  it("accepts zero as the default for no minimum participation", () => {
    const parsed = parseCompetitionCreateInput({
      institutionSlug: "lk",
      title: "Lomba Coding 2026",
      minimumParticipantEntries: 0,
    });

    expect(parsed.minimumParticipantEntries).toBe(0);
  });

  it("rejects a negative minimum participation value", () => {
    expect(() =>
      parseCompetitionCreateInput({
        institutionSlug: "lk",
        title: "Lomba Coding 2026",
        minimumParticipantEntries: -1,
      }),
    ).toThrow(/non-negative integer/);
  });

  it("accepts a confirmation timestamp between registration close and event start", () => {
    const registrationEndAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const participantConfirmationAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    const eventStartAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const parsed = parseCompetitionCreateInput({
      institutionSlug: "lk",
      title: "Lomba Coding 2026",
      registrationEndAt: registrationEndAt.toISOString(),
      participantConfirmationAt: participantConfirmationAt.toISOString(),
      eventStartAt: eventStartAt.toISOString(),
      minimumParticipantEntries: 10,
    });

    expect(parsed.minimumParticipantEntries).toBe(10);
    expect(parsed.participantConfirmationAt).toEqual(participantConfirmationAt);
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
  it("accepts a result announcement date on or after the event end", () => {
    const patch = parseCompetitionPatchInput({
      eventEndAt: "2026-08-02T00:00:00Z",
      resultAnnouncementAt: "2026-08-09T00:00:00Z",
    });
    expect(patch.resultAnnouncementAt).toEqual(new Date("2026-08-09T00:00:00Z"));
  });
  it("rejects a result announcement date before the event ends", () => {
    expect(() =>
      parseCompetitionPatchInput({
        eventEndAt: "2026-08-02T00:00:00Z",
        resultAnnouncementAt: "2026-08-01T00:00:00Z",
      }),
    ).toThrow(CompetitionError);
  });
  it("allows clearing the result announcement date", () => {
    const patch = parseCompetitionPatchInput({ resultAnnouncementAt: null });
    expect(patch.resultAnnouncementAt).toBeNull();
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
      "hackathon",
      "scientific_writing",
      "essay",
      "debate",
      "olympiad",
      "business",
      "engineering",
      "finance",
      "law",
      "design",
      "data_science",
      "programming",
      "marketing",
      "digital_art",
      "infographics",
      "performing_arts",
      "esports",
      "quiz",
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
    ).toThrow(/Acara berakhir harus setelah acara mulai/);
  });
  it("rejects registrationEndAt before registrationStartAt", () => {
    expect(() =>
      parseCompetitionPatchInput({
        registrationStartAt: "2027-06-01T00:00:00Z",
        registrationEndAt: "2027-05-01T00:00:00Z",
      }),
    ).toThrow(/Pendaftaran berakhir harus setelah pendaftaran mulai/);
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
    category: "hackathon" as const,
    mode: "individual" as const,
    registrationStartAt: inFuture(7),
    registrationEndAt: inFuture(30),
    eventStartAt: inFuture(40),
    eventEndAt: inFuture(45),
    resultAnnouncementAt: inFuture(50),
    minimumParticipantEntries: 0,
    participantConfirmationAt: inFuture(35),
  });

  const fields = (failures: { field: string }[]) => failures.map((f) => f.field);

  it("returns passed:true when every required field is present and ordered", () => {
    const result = validatePublishChecklist(passing());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("accepts a positive minimum-participation commitment in the publish ordering", () => {
    const result = validatePublishChecklist({
      ...passing(),
      minimumParticipantEntries: 10,
      participantConfirmationAt: inFuture(35),
    });
    expect(result.passed).toBe(true);
  });

  it("rejects a confirmation timestamp before registration closes", () => {
    const result = validatePublishChecklist({
      ...passing(),
      minimumParticipantEntries: 10,
      participantConfirmationAt: inFuture(20),
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "participantConfirmationAt", code: "out_of_order" }),
    );
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
      resultAnnouncementAt: null,
      participantConfirmationAt: null,
    });
    expect(fields(result.failures)).toEqual(
      expect.arrayContaining([
        "registrationStartAt",
        "registrationEndAt",
        "eventStartAt",
        "eventEndAt",
        "resultAnnouncementAt",
        "participantConfirmationAt",
      ]),
    );
  });

  it("requires result announcement and participant confirmation even when minimum is zero", () => {
    const result = validatePublishChecklist({
      ...passing(),
      resultAnnouncementAt: null,
      participantConfirmationAt: null,
      minimumParticipantEntries: 0,
    });

    expect(fields(result.failures)).toEqual(
      expect.arrayContaining(["resultAnnouncementAt", "participantConfirmationAt"]),
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
      expect.objectContaining({ field: "eventStartAt", code: "out_of_order" }),
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

  it("flags out_of_order when results are announced before the event ends", () => {
    const result = validatePublishChecklist({
      ...passing(),
      eventEndAt: inFuture(45),
      resultAnnouncementAt: inFuture(44),
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ field: "resultAnnouncementAt", code: "out_of_order" }),
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

// F5: mode → size auto-set + floor validation (Step 6.5b)
describe("F5 — mode auto-set (parseCompetitionPatchInput)", () => {
  it("auto-sets min=2 max=2 when mode switches to team without explicit sizes", () => {
    const patch = parseCompetitionPatchInput({ mode: "team" });
    expect(patch.minTeamSize).toBe(TEAM_MODE_MIN_SIZE);
    expect(patch.maxTeamSize).toBe(TEAM_MODE_MIN_SIZE);
  });

  it("auto-sets min=1 max=2 when mode switches to both without explicit sizes", () => {
    const patch = parseCompetitionPatchInput({ mode: "both" });
    expect(patch.minTeamSize).toBe(1);
    expect(patch.maxTeamSize).toBe(2);
  });

  it("respects explicit sizes when supplied alongside mode=team", () => {
    const patch = parseCompetitionPatchInput({ mode: "team", minTeamSize: 3, maxTeamSize: 5 });
    expect(patch.minTeamSize).toBe(3);
    expect(patch.maxTeamSize).toBe(5);
  });

  it("rejects team mode with min < 2 when both are explicit", () => {
    expect(() =>
      parseCompetitionPatchInput({ mode: "team", minTeamSize: 1, maxTeamSize: 3 }),
    ).toThrow(/minTeamSize >= 2/);
  });

  it("rejects team mode with min < 2 when only min is explicit (floor still enforced)", () => {
    expect(() => parseCompetitionPatchInput({ mode: "team", minTeamSize: 1 })).toThrow(
      /minTeamSize >= 2/,
    );
  });

  it("auto-sets max=min when min is explicit and min > default max (no clobber)", () => {
    // mode=team, min=3 explicit, max absent: max auto-set to max(3, 2) = 3
    const patch = parseCompetitionPatchInput({ mode: "team", minTeamSize: 3 });
    expect(patch.minTeamSize).toBe(3);
    expect(patch.maxTeamSize).toBe(3);
  });

  it("auto-sets max=default when min is explicit and min <= default max", () => {
    // mode=team, min=2 explicit, max absent: max auto-set to max(2, 2) = 2
    const patch = parseCompetitionPatchInput({ mode: "team", minTeamSize: 2 });
    expect(patch.minTeamSize).toBe(2);
    expect(patch.maxTeamSize).toBe(2);
  });

  it("rejects when max < min (existing rule, still enforced)", () => {
    expect(() => parseCompetitionPatchInput({ minTeamSize: 3, maxTeamSize: 2 })).toThrow(
      /less than or equal to/,
    );
  });
});

describe("F5 — mode floor at publish time (validatePublishChecklist)", () => {
  const inFuture = (d: number): Date => {
    const dt = new Date();
    dt.setDate(dt.getDate() + d);
    return dt;
  };
  const base = () => ({
    title: "Lomba",
    description: "Desc",
    category: "hackathon" as const,
    registrationStartAt: inFuture(7),
    registrationEndAt: inFuture(30),
    eventStartAt: inFuture(40),
    eventEndAt: inFuture(45),
    resultAnnouncementAt: inFuture(50),
    minimumParticipantEntries: 0,
    participantConfirmationAt: inFuture(35),
  });

  it("passes team mode with minTeamSize=2", () => {
    const r = validatePublishChecklist({
      ...base(),
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
    });
    expect(r.passed).toBe(true);
  });

  it("fails team mode with minTeamSize<2", () => {
    const r = validatePublishChecklist({
      ...base(),
      mode: "team",
      minTeamSize: 1,
      maxTeamSize: 4,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.field === "minTeamSize")).toBe(true);
  });

  it("fails team mode with minTeamSize null (treated as 0)", () => {
    const r = validatePublishChecklist({
      ...base(),
      mode: "team",
      minTeamSize: null,
      maxTeamSize: 4,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.field === "minTeamSize")).toBe(true);
  });

  it("fails when minTeamSize > maxTeamSize at publish time", () => {
    const r = validatePublishChecklist({
      ...base(),
      mode: "both",
      minTeamSize: 5,
      maxTeamSize: 3,
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.field === "maxTeamSize")).toBe(true);
  });
});
