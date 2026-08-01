import { describe, expect, it } from "vitest";
import {
  canWithdrawPublication,
  hasCompetitionStarted,
} from "@/lib/competitions/competition-withdrawal";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const BEFORE = "2026-07-20T00:00:00.000Z";
const AFTER = "2026-08-10T00:00:00.000Z";

describe("hasCompetitionStarted", () => {
  it("is false before the start", () => {
    expect(hasCompetitionStarted(new Date(AFTER), NOW)).toBe(false);
  });

  it("is true after the start", () => {
    expect(hasCompetitionStarted(new Date(BEFORE), NOW)).toBe(true);
  });

  it("includes the boundary — at the start time the competition is under way", () => {
    expect(hasCompetitionStarted(NOW, NOW)).toBe(true);
  });

  it("is false without a start date", () => {
    expect(hasCompetitionStarted(null, NOW)).toBe(false);
  });

  it("accepts ISO strings, as the client receives them", () => {
    expect(hasCompetitionStarted(BEFORE, NOW)).toBe(true);
  });

  it("treats an unparseable date as absent rather than throwing", () => {
    expect(hasCompetitionStarted("not-a-date", NOW)).toBe(false);
  });
});

describe("canWithdrawPublication", () => {
  it("closes withdrawal at participantConfirmationAt regardless of event progress or registrations", () => {
    const confirmationAt = new Date("2026-08-10T00:00:00.000Z");
    expect(
      canWithdrawPublication(
        {
          eventStartAt: new Date("2026-08-20T00:00:00.000Z"),
          participantConfirmationAt: confirmationAt,
          hasActiveRegistrations: false,
        },
        confirmationAt,
      ),
    ).toBe(false);
  });

  it("allows withdrawal before the start, even with registrations", () => {
    expect(canWithdrawPublication({ eventStartAt: AFTER, hasActiveRegistrations: true }, NOW)).toBe(
      true,
    );
  });

  it("refuses withdrawal once started while registrations exist", () => {
    expect(
      canWithdrawPublication({ eventStartAt: BEFORE, hasActiveRegistrations: true }, NOW),
    ).toBe(false);
  });

  it("allows withdrawal after the start when nobody is registered", () => {
    expect(
      canWithdrawPublication({ eventStartAt: BEFORE, hasActiveRegistrations: false }, NOW),
    ).toBe(true);
  });

  it("stays refused long after the event has finished — the block never lifts", () => {
    const longPast = "2020-01-01T00:00:00.000Z";
    expect(
      canWithdrawPublication({ eventStartAt: longPast, hasActiveRegistrations: true }, NOW),
    ).toBe(false);
  });

  it("refuses from the exact start instant", () => {
    expect(canWithdrawPublication({ eventStartAt: NOW, hasActiveRegistrations: true }, NOW)).toBe(
      false,
    );
  });

  it("allows withdrawal with no start date at all", () => {
    expect(canWithdrawPublication({ eventStartAt: null, hasActiveRegistrations: true }, NOW)).toBe(
      true,
    );
  });
});
