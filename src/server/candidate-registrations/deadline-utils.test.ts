// @vitest-environment node

import { describe, expect, it } from "vitest";
import { deriveUpcomingDeadlines } from "./deadline-utils";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const D1 = new Date("2026-07-01T00:00:00.000Z");
const D2 = new Date("2026-08-01T00:00:00.000Z");
const D3 = new Date("2026-09-01T00:00:00.000Z");
const D4 = new Date("2026-10-01T00:00:00.000Z");

const reg = (overrides: {
  registrationStatus?: string;
  registrationEndAt?: Date | null;
  eventStartAt?: Date | null;
  competitionTitle?: string;
}) => ({
  registrationStatus: "confirmed",
  registrationEndAt: null,
  eventStartAt: null,
  competitionTitle: "Comp",
  ...overrides,
});

describe("deriveUpcomingDeadlines", () => {
  it("excludes cancelled registrations entirely", () => {
    const regs = [
      reg({ registrationStatus: "cancelled", registrationEndAt: D1, eventStartAt: D2 }),
    ];
    expect(deriveUpcomingDeadlines(regs, NOW)).toEqual([]);
  });

  it("excludes dates in the past (not strictly in the future)", () => {
    const regs = [reg({ registrationEndAt: PAST, eventStartAt: PAST })];
    expect(deriveUpcomingDeadlines(regs, NOW)).toEqual([]);
  });

  it("excludes dates equal to now (must be strictly after)", () => {
    const regs = [reg({ registrationEndAt: NOW })];
    expect(deriveUpcomingDeadlines(regs, NOW)).toEqual([]);
  });

  it("returns registration_closes and event_starts labels correctly", () => {
    const regs = [reg({ registrationEndAt: D1, eventStartAt: D2, competitionTitle: "Hackathon" })];
    const result = deriveUpcomingDeadlines(regs, NOW);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      label: "registration_closes",
      date: D1,
      competitionTitle: "Hackathon",
    });
    expect(result[1]).toMatchObject({
      label: "event_starts",
      date: D2,
      competitionTitle: "Hackathon",
    });
  });

  it("returns at most 3 deadlines even when more exist", () => {
    const regs = [
      reg({ registrationEndAt: D1, eventStartAt: D2, competitionTitle: "A" }),
      reg({ registrationEndAt: D3, eventStartAt: D4, competitionTitle: "B" }),
    ];
    const result = deriveUpcomingDeadlines(regs, NOW);
    expect(result).toHaveLength(3);
  });

  it("sorts results ascending by date", () => {
    const regs = [
      reg({ registrationEndAt: D3, eventStartAt: null, competitionTitle: "B" }),
      reg({ registrationEndAt: D1, eventStartAt: null, competitionTitle: "A" }),
    ];
    const result = deriveUpcomingDeadlines(regs, NOW);
    expect(result[0]?.date).toEqual(D1);
    expect(result[1]?.date).toEqual(D3);
  });

  it("de-duplicates entries with the same label and date", () => {
    const regs = [
      reg({ registrationEndAt: D1, competitionTitle: "A" }),
      reg({ registrationEndAt: D1, competitionTitle: "B" }),
    ];
    const result = deriveUpcomingDeadlines(regs, NOW);
    // Only one entry for D1 registration_closes
    expect(result.filter((r) => r.label === "registration_closes" && r.date === D1)).toHaveLength(
      1,
    );
  });

  it("returns empty array when all registrations are cancelled", () => {
    const regs = [
      reg({ registrationStatus: "cancelled", registrationEndAt: D1 }),
      reg({ registrationStatus: "cancelled", eventStartAt: D2 }),
    ];
    expect(deriveUpcomingDeadlines(regs, NOW)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(deriveUpcomingDeadlines([], NOW)).toEqual([]);
  });
});
