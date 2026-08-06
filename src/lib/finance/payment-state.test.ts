// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  comparePaymentEvents,
  foldPaymentEvents,
  type FoldablePaymentEvent,
} from "@/lib/finance/payment-state";
import type { PaymentEventType } from "@/lib/finance/payment-model";

let seq = 0;

const event = (
  eventType: PaymentEventType,
  occurredAtIso: string,
  amount: number | null = null,
): FoldablePaymentEvent => ({
  id: `evt_${String(seq++).padStart(4, "0")}`,
  eventType,
  occurredAt: new Date(occurredAtIso),
  recordedAt: new Date(occurredAtIso),
  amount,
  currency: amount === null ? null : "IDR",
});

describe("foldPaymentEvents", () => {
  it("reports pending for a payment with no events", () => {
    const state = foldPaymentEvents([]);

    expect(state.status).toBe("pending");
    expect(state.eventCount).toBe(0);
    expect(state.netRecordedAmount).toBe(0);
    expect(state.currency).toBeNull();
  });

  it("reports pending after an attempt is initiated", () => {
    const state = foldPaymentEvents([event("initiated", "2026-08-01T00:00:00Z")]);

    expect(state.status).toBe("pending");
  });

  it("reports succeeded and the captured amount once funds move", () => {
    const state = foldPaymentEvents([
      event("initiated", "2026-08-01T00:00:00Z"),
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
    ]);

    expect(state.status).toBe("succeeded");
    expect(state.capturedAmount).toBe(150_000);
    expect(state.netRecordedAmount).toBe(150_000);
    expect(state.currency).toBe("IDR");
  });

  it("reports failed and expired only while nothing has succeeded", () => {
    expect(foldPaymentEvents([event("failed", "2026-08-01T00:01:00Z")]).status).toBe("failed");
    expect(foldPaymentEvents([event("expired", "2026-08-01T00:01:00Z")]).status).toBe("expired");
  });

  it("does not let a later failure undo a payment that took money", () => {
    // A gateway that reports a stale failure after a capture must not be able to make a payment
    // read as though the money never moved. Only a refund reverses a capture.
    const state = foldPaymentEvents([
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
      event("failed", "2026-08-01T00:09:00Z"),
    ]);

    expect(state.status).toBe("succeeded");
    expect(state.capturedAmount).toBe(150_000);
  });

  it("a refund leaves the original success fully readable and reports the payment as refunded", () => {
    const succeeded = event("succeeded", "2026-08-01T00:05:00Z", 150_000);
    const refunded = event("refunded", "2026-08-04T10:00:00Z", 150_000);

    const state = foldPaymentEvents([succeeded, refunded]);

    expect(state.status).toBe("refunded");
    // The reversal is a new row; the success it reverses is untouched and still in the stream.
    expect(state.capturedAmount).toBe(150_000);
    expect(state.refundedAmount).toBe(150_000);
    expect(state.netRecordedAmount).toBe(0);
    expect(state.eventCount).toBe(2);
    expect(succeeded.amount).toBe(150_000);
    expect(succeeded.eventType).toBe("succeeded");
  });

  it("keeps a partially refunded payment succeeded, with the refund visible", () => {
    const state = foldPaymentEvents([
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
      event("refunded", "2026-08-04T10:00:00Z", 50_000),
    ]);

    expect(state.status).toBe("succeeded");
    expect(state.refundedAmount).toBe(50_000);
    expect(state.netRecordedAmount).toBe(100_000);
  });

  it("accumulates partial refunds until they cover the capture", () => {
    const state = foldPaymentEvents([
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
      event("refunded", "2026-08-04T10:00:00Z", 50_000),
      event("refunded", "2026-08-05T10:00:00Z", 100_000),
    ]);

    expect(state.status).toBe("refunded");
    expect(state.netRecordedAmount).toBe(0);
  });

  it("a correction appears as its own event and never moves status", () => {
    const state = foldPaymentEvents([
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
      event("corrected", "2026-08-02T09:00:00Z", -20_000),
    ]);

    expect(state.status).toBe("succeeded");
    // The original capture is unchanged; the restatement is a separate, signed figure.
    expect(state.capturedAmount).toBe(150_000);
    expect(state.correctionAmount).toBe(-20_000);
    expect(state.netRecordedAmount).toBe(130_000);
    expect(state.eventCount).toBe(2);
  });

  it("a correction alone cannot make an unsuccessful payment look successful", () => {
    const state = foldPaymentEvents([
      event("failed", "2026-08-01T00:05:00Z"),
      event("corrected", "2026-08-02T09:00:00Z", 150_000),
    ]);

    expect(state.status).toBe("failed");
  });

  it("folds to the same state whatever order the events arrive in", () => {
    const events = [
      event("initiated", "2026-08-01T00:00:00Z"),
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
      event("refunded", "2026-08-04T10:00:00Z", 150_000),
      event("corrected", "2026-08-05T09:00:00Z", -1_000),
    ];

    const forward = foldPaymentEvents(events);
    const reversed = foldPaymentEvents([...events].reverse());
    const shuffled = foldPaymentEvents([events[2]!, events[0]!, events[3]!, events[1]!]);

    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.lastEventAt).toEqual(new Date("2026-08-05T09:00:00Z"));
  });

  it("does not mutate the caller's array while sorting", () => {
    const events = [
      event("refunded", "2026-08-04T10:00:00Z", 150_000),
      event("succeeded", "2026-08-01T00:05:00Z", 150_000),
    ];
    const originalOrder = events.map((e) => e.id);

    foldPaymentEvents(events);

    expect(events.map((e) => e.id)).toEqual(originalOrder);
  });
});

describe("comparePaymentEvents", () => {
  it("orders by occurrence, then by when it was recorded, then by id", () => {
    const early = { ...event("succeeded", "2026-08-01T00:00:00Z", 1) };
    const late = { ...event("refunded", "2026-08-02T00:00:00Z", 1) };
    expect(comparePaymentEvents(early, late)).toBeLessThan(0);

    // Same instant, recorded at different times — the later arrival sorts second.
    const sameInstantEarlyRecord = {
      ...event("succeeded", "2026-08-01T00:00:00Z", 1),
      recordedAt: new Date("2026-08-01T00:00:00Z"),
      id: "evt_zzz",
    };
    const sameInstantLateRecord = {
      ...event("failed", "2026-08-01T00:00:00Z"),
      recordedAt: new Date("2026-08-01T06:00:00Z"),
      id: "evt_aaa",
    };
    expect(comparePaymentEvents(sameInstantEarlyRecord, sameInstantLateRecord)).toBeLessThan(0);

    // Same instant and same arrival — id is the final, stable tiebreak.
    const a = { ...sameInstantEarlyRecord, id: "evt_a" };
    const b = { ...sameInstantEarlyRecord, id: "evt_b" };
    expect(comparePaymentEvents(a, b)).toBeLessThan(0);
    expect(comparePaymentEvents(b, a)).toBeGreaterThan(0);
    expect(comparePaymentEvents(a, a)).toBe(0);
  });
});
