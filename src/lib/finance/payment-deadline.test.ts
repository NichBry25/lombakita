import { describe, expect, it } from "vitest";
import {
  DEADLINE_URGENT_WITHIN_MS,
  describePaymentDeadline,
  formatTimeRemaining,
} from "./payment-deadline";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("describePaymentDeadline", () => {
  it("reports nothing when the payment carries no deadline", () => {
    expect(describePaymentDeadline(null, { suspended: false, now: NOW })).toEqual({ kind: "none" });
  });

  it("counts down while the deadline is in the future", () => {
    expect(describePaymentDeadline(at(3 * DAY), { suspended: false, now: NOW })).toMatchObject({
      kind: "remaining",
      urgent: false,
    });
  });

  it("marks the last day urgent", () => {
    expect(describePaymentDeadline(at(5 * HOUR), { suspended: false, now: NOW })).toMatchObject({
      kind: "remaining",
      urgent: true,
    });
  });

  it("treats the urgency boundary as inclusive", () => {
    expect(
      describePaymentDeadline(at(DEADLINE_URGENT_WITHIN_MS), { suspended: false, now: NOW }),
    ).toMatchObject({ urgent: true });
    expect(
      describePaymentDeadline(at(DEADLINE_URGENT_WITHIN_MS + 1), { suspended: false, now: NOW }),
    ).toMatchObject({ urgent: false });
  });

  it("reports the deadline passed once the instant is reached", () => {
    // Inclusive: at exactly the deadline, the time to act is over.
    expect(describePaymentDeadline(at(0), { suspended: false, now: NOW })).toMatchObject({
      kind: "passed",
    });
  });

  it("SUSPENDS instead of counting down while evidence is under review", () => {
    expect(describePaymentDeadline(at(2 * DAY), { suspended: true, now: NOW })).toEqual({
      kind: "suspended",
      dueAt: at(2 * DAY),
    });
  });

  it("SUSPENDS even when the deadline has already gone by", () => {
    // THE CASE THE RULING IS ABOUT. A candidate who submitted in time and is waiting on a slow
    // organiser is not late. The worker will not expire them, and neither may the page say so.
    expect(describePaymentDeadline(at(-5 * DAY), { suspended: true, now: NOW })).toMatchObject({
      kind: "suspended",
    });
  });
});

describe("formatTimeRemaining", () => {
  it("rounds DOWN, never promising time the candidate does not have", () => {
    expect(formatTimeRemaining(2 * DAY + 23 * HOUR)).toBe("2 hari lagi");
  });

  it("steps down through days, hours and minutes", () => {
    expect(formatTimeRemaining(3 * DAY)).toBe("3 hari lagi");
    expect(formatTimeRemaining(5 * HOUR)).toBe("5 jam lagi");
    expect(formatTimeRemaining(12 * 60 * 1000)).toBe("12 menit lagi");
    expect(formatTimeRemaining(30 * 1000)).toBe("kurang dari semenit lagi");
  });
});
