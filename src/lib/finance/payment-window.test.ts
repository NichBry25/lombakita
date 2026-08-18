import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_WINDOW_DAYS,
  isValidPaymentWindowDays,
  MAX_PAYMENT_WINDOW_DAYS,
  MIN_PAYMENT_WINDOW_DAYS,
  resolvePaymentDueAt,
} from "@/lib/finance/payment-window";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-08-10T09:00:00.000Z");

describe("isValidPaymentWindowDays", () => {
  it("accepts the shipped bounds and the default", () => {
    expect(isValidPaymentWindowDays(MIN_PAYMENT_WINDOW_DAYS)).toBe(true);
    expect(isValidPaymentWindowDays(MAX_PAYMENT_WINDOW_DAYS)).toBe(true);
    expect(isValidPaymentWindowDays(DEFAULT_PAYMENT_WINDOW_DAYS)).toBe(true);
  });

  it("refuses a window below the floor — it would expire a payer who did nothing wrong", () => {
    expect(isValidPaymentWindowDays(0)).toBe(false);
    expect(isValidPaymentWindowDays(-1)).toBe(false);
  });

  it("refuses a fractional window", () => {
    expect(isValidPaymentWindowDays(1.5)).toBe(false);
  });

  it("refuses a window past the ceiling", () => {
    expect(isValidPaymentWindowDays(MAX_PAYMENT_WINDOW_DAYS + 1)).toBe(false);
  });
});

describe("resolvePaymentDueAt", () => {
  it("adds the window to the start when nothing clamps it", () => {
    const due = resolvePaymentDueAt(START, 3, null);
    expect(due.getTime()).toBe(START.getTime() + 3 * DAY_MS);
  });

  it("CLAMPS to registration close when the window would run past it", () => {
    // The rule that matters: a payment still open after registration closed is a registration
    // nobody can honour.
    const registrationEnd = new Date(START.getTime() + DAY_MS);
    const due = resolvePaymentDueAt(START, 7, registrationEnd);
    expect(due.getTime()).toBe(registrationEnd.getTime());
  });

  it("does not extend a short window up to registration close", () => {
    const registrationEnd = new Date(START.getTime() + 30 * DAY_MS);
    const due = resolvePaymentDueAt(START, 2, registrationEnd);
    expect(due.getTime()).toBe(START.getTime() + 2 * DAY_MS);
  });

  it("returns a past deadline truthfully when registration has already closed", () => {
    // Deliberately NOT floored to `startedAt`. The caller deciding whether to open a payment is
    // the one that must refuse; inventing grace here would hide that it needed to.
    const registrationEnd = new Date(START.getTime() - DAY_MS);
    const due = resolvePaymentDueAt(START, 3, registrationEnd);
    expect(due.getTime()).toBe(registrationEnd.getTime());
    expect(due.getTime()).toBeLessThan(START.getTime());
  });

  it("is a pure function of its inputs — the same call twice gives the same instant", () => {
    const end = new Date(START.getTime() + 10 * DAY_MS);
    expect(resolvePaymentDueAt(START, 3, end).getTime()).toBe(
      resolvePaymentDueAt(START, 3, end).getTime(),
    );
  });
});
