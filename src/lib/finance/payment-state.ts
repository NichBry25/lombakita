// A payment's current state, DERIVED by folding its event stream (DEC-0133).
//
// There is no status column on `finance_payments` and no balance table anywhere. A projected
// status is a second copy of a fact the events already carry, and the two disagree the first time
// a write half-fails — which in a financial system is the moment the copy is trusted most. Folding
// costs one indexed read and can only ever answer what the events say.
//
// The fold is also what makes append-only usable: a refund does not edit the payment it reverses,
// it appends a reversing event, and this function is where "there was a success AND a refund"
// becomes "refunded" without either row being touched.
//
// Client-safe: pure, no server-only imports, no I/O.

import type { PaymentEventType } from "@/lib/finance/payment-model";

export type PaymentDerivedStatus =
  // No terminal event yet — including a payment with no events at all.
  "pending" | "succeeded" | "failed" | "expired" | "refunded";

export type FoldablePaymentEvent = {
  id: string;
  eventType: PaymentEventType;
  occurredAt: Date;
  recordedAt: Date;
  amount: number | null;
  currency: string | null;
};

export type PaymentDerivedState = {
  status: PaymentDerivedStatus;
  // Sum of every `succeeded` event's amount.
  capturedAmount: number;
  // Sum of every `refunded` event's amount. Partial refunds accumulate.
  refundedAmount: number;
  // Signed sum of every `corrected` event's amount.
  correctionAmount: number;
  // captured − refunded + corrections. What the stream says actually moved, net of reversals.
  netRecordedAmount: number;
  // The currency the monetary events agree on, or null when the stream carries no monetary event.
  currency: string | null;
  eventCount: number;
  lastEventAt: Date | null;
};

/**
 * The canonical event ordering: when it happened, then when we recorded it, then id.
 *
 * `occurred_at` alone is not enough — two events can share an instant, and a gateway can report
 * the same timestamp for an attempt and its outcome. `recorded_at` breaks that tie by arrival, and
 * `id` breaks the remainder, so the same set of rows always folds to the same answer regardless of
 * the order the database happened to return them in.
 */
export const comparePaymentEvents = (a: FoldablePaymentEvent, b: FoldablePaymentEvent): number => {
  const byOccurred = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byOccurred !== 0) return byOccurred;

  const byRecorded = a.recordedAt.getTime() - b.recordedAt.getTime();
  if (byRecorded !== 0) return byRecorded;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Folds a payment's events into its current state.
 *
 * The input is sorted defensively with `comparePaymentEvents` rather than trusted to arrive
 * ordered, so a caller that forgets an ORDER BY gets the right answer instead of a different one.
 *
 * Status precedence, which is the whole of the state machine:
 *   - a full refund wins outright; a payment whose refunds cover its captures reads `refunded`
 *   - `succeeded` cannot be undone by a later `failed` or `expired`. Those still appear in the
 *     stream and are still readable, but a payment that took money did take it; only a refund
 *     reverses that
 *   - `failed` and `expired` apply only while nothing has succeeded, last one winning
 *   - `corrected` NEVER moves status. It restates figures and carries its own reason; a correction
 *     that could silently flip a payment's status would be an edit wearing an event's clothes
 */
export const foldPaymentEvents = (events: readonly FoldablePaymentEvent[]): PaymentDerivedState => {
  const ordered = [...events].sort(comparePaymentEvents);

  let capturedAmount = 0;
  let refundedAmount = 0;
  let correctionAmount = 0;
  let currency: string | null = null;
  let lastEventAt: Date | null = null;
  let succeeded = false;
  let unsuccessfulOutcome: "failed" | "expired" | null = null;

  for (const event of ordered) {
    lastEventAt = event.occurredAt;

    if (event.currency !== null && currency === null) {
      currency = event.currency;
    }

    switch (event.eventType) {
      case "succeeded":
        succeeded = true;
        capturedAmount += event.amount ?? 0;
        break;
      case "refunded":
        refundedAmount += event.amount ?? 0;
        break;
      case "corrected":
        correctionAmount += event.amount ?? 0;
        break;
      case "failed":
        unsuccessfulOutcome = "failed";
        break;
      case "expired":
        unsuccessfulOutcome = "expired";
        break;
      case "initiated":
        break;
    }
  }

  return {
    status: resolveStatus({ succeeded, unsuccessfulOutcome, capturedAmount, refundedAmount }),
    capturedAmount,
    refundedAmount,
    correctionAmount,
    netRecordedAmount: capturedAmount - refundedAmount + correctionAmount,
    currency,
    eventCount: ordered.length,
    lastEventAt,
  };
};

const resolveStatus = (input: {
  succeeded: boolean;
  unsuccessfulOutcome: "failed" | "expired" | null;
  capturedAmount: number;
  refundedAmount: number;
}): PaymentDerivedStatus => {
  if (input.succeeded) {
    // A partial refund leaves the payment succeeded with a non-zero refundedAmount — it did take
    // money and some of it stayed. Only refunds covering the capture make it `refunded`.
    const fullyRefunded = input.capturedAmount > 0 && input.refundedAmount >= input.capturedAmount;
    return fullyRefunded ? "refunded" : "succeeded";
  }

  return input.unsuccessfulOutcome ?? "pending";
};
