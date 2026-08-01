// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  deriveCompetitionPhase,
  getCompetitionPhaseBadgeStatus,
  getCompetitionPhaseLabel,
  isAwaitingResultsPhase,
  resolveResultAnnouncement,
  DEFAULT_RESULT_ANNOUNCEMENT_DAYS,
  RESULT_ANNOUNCEMENT_GRACE_DAYS,
  type CompetitionPhaseInput,
} from "./competition-phase";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const offsetFromNow = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const input = (overrides: Partial<CompetitionPhaseInput> = {}): CompetitionPhaseInput => ({
  cancelledAt: null,
  registrationStartAt: offsetFromNow(-30),
  registrationEndAt: offsetFromNow(-20),
  eventStartAt: offsetFromNow(-10),
  eventEndAt: offsetFromNow(-5),
  resultAnnouncementAt: null,
  hasPublishedResult: false,
  ...overrides,
});

describe("deriveCompetitionPhase", () => {
  it("gives cancellation precedence over results and dates", () => {
    expect(
      deriveCompetitionPhase(
        input({
          cancelledAt: offsetFromNow(-1),
          hasPublishedResult: true,
          eventEndAt: offsetFromNow(-30),
        }),
        NOW,
      ),
    ).toBe("cancelled");
  });

  it("reports upcoming before registration opens", () => {
    const phase = deriveCompetitionPhase(
      input({
        registrationStartAt: offsetFromNow(5),
        registrationEndAt: offsetFromNow(20),
        eventStartAt: offsetFromNow(30),
        eventEndAt: offsetFromNow(31),
      }),
      NOW,
    );
    expect(phase).toBe("upcoming");
  });

  it("reports registration_open inside the window", () => {
    const phase = deriveCompetitionPhase(
      input({
        registrationStartAt: offsetFromNow(-1),
        registrationEndAt: offsetFromNow(20),
        eventStartAt: offsetFromNow(30),
        eventEndAt: offsetFromNow(31),
      }),
      NOW,
    );
    expect(phase).toBe("registration_open");
  });

  it("reports registration_closing inside the final seven days", () => {
    const phase = deriveCompetitionPhase(
      input({
        registrationStartAt: offsetFromNow(-1),
        registrationEndAt: offsetFromNow(3),
        eventStartAt: offsetFromNow(30),
        eventEndAt: offsetFromNow(31),
      }),
      NOW,
    );
    expect(phase).toBe("registration_closing");
  });

  it("reports registration_closed between the deadline and the event", () => {
    const phase = deriveCompetitionPhase(
      input({
        registrationStartAt: offsetFromNow(-30),
        registrationEndAt: offsetFromNow(-2),
        eventStartAt: offsetFromNow(10),
        eventEndAt: offsetFromNow(11),
      }),
      NOW,
    );
    expect(phase).toBe("registration_closed");
  });

  it("reports in_progress while the event is running", () => {
    const phase = deriveCompetitionPhase(
      input({ eventStartAt: offsetFromNow(-1), eventEndAt: offsetFromNow(1) }),
      NOW,
    );
    expect(phase).toBe("in_progress");
  });

  it("reports awaiting_results once the event has ended with no result", () => {
    expect(deriveCompetitionPhase(input(), NOW)).toBe("awaiting_results");
  });

  it("reports awaiting_results before the promised date has passed", () => {
    const phase = deriveCompetitionPhase(input({ resultAnnouncementAt: offsetFromNow(3) }), NOW);
    expect(phase).toBe("awaiting_results");
  });

  // The grace window is the whole point of not shaming an organizer who is a few days late.
  it("stays awaiting_results inside the grace window after the promised date", () => {
    const phase = deriveCompetitionPhase(
      input({ resultAnnouncementAt: offsetFromNow(-(RESULT_ANNOUNCEMENT_GRACE_DAYS - 1)) }),
      NOW,
    );
    expect(phase).toBe("awaiting_results");
  });

  it("reports results_overdue past the promised date plus the grace window", () => {
    const phase = deriveCompetitionPhase(
      input({ resultAnnouncementAt: offsetFromNow(-(RESULT_ANNOUNCEMENT_GRACE_DAYS + 1)) }),
      NOW,
    );
    expect(phase).toBe("results_overdue");
  });

  // An organizer who names no date is still accountable: the due date falls back to the event
  // end plus the default window, so leaving the field blank is not a way to never be late.
  it("reports results_overdue from the derived date when none was declared", () => {
    const daysPastEvent = DEFAULT_RESULT_ANNOUNCEMENT_DAYS + RESULT_ANNOUNCEMENT_GRACE_DAYS + 1;
    const phase = deriveCompetitionPhase(
      input({ resultAnnouncementAt: null, eventEndAt: offsetFromNow(-daysPastEvent) }),
      NOW,
    );
    expect(phase).toBe("results_overdue");
  });

  it("stays awaiting_results before the derived date plus grace has passed", () => {
    const daysPastEvent = DEFAULT_RESULT_ANNOUNCEMENT_DAYS + RESULT_ANNOUNCEMENT_GRACE_DAYS - 1;
    const phase = deriveCompetitionPhase(
      input({ resultAnnouncementAt: null, eventEndAt: offsetFromNow(-daysPastEvent) }),
      NOW,
    );
    expect(phase).toBe("awaiting_results");
  });

  // With no event end there is nothing to derive from, so nothing to be late against. Matches the
  // retention purge, which likewise skips a competition with no event_end_at.
  it("never reports results_overdue when the competition has no event end date", () => {
    const phase = deriveCompetitionPhase(
      input({ resultAnnouncementAt: null, eventEndAt: null, eventStartAt: offsetFromNow(-400) }),
      NOW,
    );
    expect(phase).toBe("in_progress");
  });

  it("reports results_announced once a result is published, overriding a lapsed date", () => {
    const phase = deriveCompetitionPhase(
      input({
        hasPublishedResult: true,
        resultAnnouncementAt: offsetFromNow(-(RESULT_ANNOUNCEMENT_GRACE_DAYS + 30)),
      }),
      NOW,
    );
    expect(phase).toBe("results_announced");
  });

  it("accepts ISO strings as well as Dates", () => {
    const phase = deriveCompetitionPhase(
      input({
        eventStartAt: offsetFromNow(-1).toISOString(),
        eventEndAt: offsetFromNow(1).toISOString(),
      }),
      NOW,
    );
    expect(phase).toBe("in_progress");
  });

  // Every date is nullable on a competition, so a bare row must still resolve to something.
  it("falls back to registration_open when every date is absent", () => {
    const phase = deriveCompetitionPhase(
      {
        registrationStartAt: null,
        registrationEndAt: null,
        eventStartAt: null,
        eventEndAt: null,
        resultAnnouncementAt: null,
        hasPublishedResult: false,
      },
      NOW,
    );
    expect(phase).toBe("registration_open");
  });

  it("ignores an unparseable date rather than throwing", () => {
    const phase = deriveCompetitionPhase(input({ eventEndAt: "not-a-date" }), NOW);
    expect(phase).toBe("in_progress");
  });
});

describe("resolveResultAnnouncement", () => {
  it("reports a declared date as declared", () => {
    const declared = offsetFromNow(10);
    const resolved = resolveResultAnnouncement({
      resultAnnouncementAt: declared,
      eventEndAt: offsetFromNow(-5),
    });
    expect(resolved.source).toBe("declared");
    expect(resolved.at).toEqual(declared);
  });

  it("derives the due date from the event end when none was declared", () => {
    const eventEnd = offsetFromNow(-5);
    const resolved = resolveResultAnnouncement({
      resultAnnouncementAt: null,
      eventEndAt: eventEnd,
    });
    expect(resolved.source).toBe("derived");
    expect(resolved.at).toEqual(
      new Date(eventEnd.getTime() + DEFAULT_RESULT_ANNOUNCEMENT_DAYS * DAY),
    );
  });

  it("reports none when neither a declared date nor an event end exists", () => {
    const resolved = resolveResultAnnouncement({ resultAnnouncementAt: null, eventEndAt: null });
    expect(resolved).toEqual({ at: null, source: "none" });
  });

  // A declared date wins even when it sits before the derived one would.
  it("prefers a declared date over the derived fallback", () => {
    const declared = offsetFromNow(-4);
    const resolved = resolveResultAnnouncement({
      resultAnnouncementAt: declared,
      eventEndAt: offsetFromNow(-5),
    });
    expect(resolved.at).toEqual(declared);
    expect(resolved.source).toBe("declared");
  });
});

describe("phase presentation", () => {
  it("labels and badges every phase", () => {
    const phases = [
      "upcoming",
      "registration_open",
      "registration_closing",
      "registration_closed",
      "in_progress",
      "awaiting_results",
      "results_overdue",
      "results_announced",
    ] as const;
    for (const phase of phases) {
      expect(getCompetitionPhaseLabel(phase)).toBeTruthy();
      expect(getCompetitionPhaseBadgeStatus(phase)).toBeTruthy();
    }
  });

  // The overdue label must report the fact, never quantify the delay.
  it("keeps the overdue label neutral", () => {
    expect(getCompetitionPhaseLabel("results_overdue")).toBe("Hasil belum diumumkan");
  });

  it("treats both waiting phases as awaiting results", () => {
    expect(isAwaitingResultsPhase("awaiting_results")).toBe(true);
    expect(isAwaitingResultsPhase("results_overdue")).toBe(true);
    expect(isAwaitingResultsPhase("results_announced")).toBe(false);
    expect(isAwaitingResultsPhase("registration_open")).toBe(false);
  });
});
