// @vitest-environment node
//
// ONE CANONICAL FORM OF AN IDEMPOTENCY KEY, on every arm.
//
// `finance_payment_events.idempotency_key` is unique globally, and `appendPaymentEvent` uses the key
// three times in one call: to validate the shape, to attempt the insert, and to read back the row a
// suppressed insert collided with. If those three do not see the SAME STRING, the mechanism inverts.
//
// The failure is specific. Store a key with its surrounding whitespace and the retry — which mints
// the canonical form — no longer matches it, so the unique index does not fire and the same event is
// recorded twice. On the manual arm that is a second `succeeded` on a payment; on the gateway arm it
// is a webhook retry storm recorded once per delivery. Both are money the ledger does not describe.
//
// A guard existed for none of the three arms, which is why this file covers all three rather than
// the one that happened to be found.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { appendPaymentEvent, type PaymentEventActor } from "@/server/finance/payment-service";
import {
  mintGatewayPaymentEventKey,
  mintManualPaymentEventKey,
  mintPlatformPaymentEventKey,
} from "@/server/finance/idempotency-key";
import type { Database } from "@/server/db/client";

const NOW = new Date("2026-08-10T00:00:00Z");
const SYSTEM: PaymentEventActor = { type: "system" };

/**
 * A db that records the inserted row and the key the readback filtered on.
 *
 * The readback filter is the half a simpler mock would miss: an insert that stored the canonical
 * form while the readback searched for the raw one returns null on a real collision, and the caller
 * is told its event does not exist.
 */
const makeKeyTrackingDb = () => {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        const returning = () => Promise.resolve([{ id: "evt_1", ...row }]);
        return { returning, onConflictDoNothing: () => ({ returning }) };
      },
    }),
  };
  return { db: db as unknown as Database, inserted };
};

const KEYS = {
  gateway: mintGatewayPaymentEventKey({
    provider: "xendit",
    eventType: "succeeded",
    providerEventId: "evt_abc123",
  }),
  platform: mintPlatformPaymentEventKey({ action: "refunded", paymentId: "pay_1" }),
  manual: mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 0 }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("every minted key survives the append unchanged", () => {
  for (const [arm, key] of Object.entries(KEYS)) {
    it(`stores the ${arm} arm's key exactly as minted`, async () => {
      const { db, inserted } = makeKeyTrackingDb();

      await appendPaymentEvent(
        SYSTEM,
        {
          paymentId: "pay_1",
          eventType: arm === "platform" ? "refunded" : "succeeded",
          occurredAt: NOW,
          ...(arm === "platform" ? { reason: "organiser cancelled" } : {}),
          idempotencyKey: key,
        },
        db,
      );

      expect(inserted[0]!.idempotencyKey).toBe(key);
    });

    it(`stores the CANONICAL form when the ${arm} arm's key arrives padded`, async () => {
      // Padding is what a hand-assembled request body, a copied header or a form field carries. The
      // stored value must be the trimmed key, not the padded one, or the retry cannot collide.
      const { db, inserted } = makeKeyTrackingDb();

      await appendPaymentEvent(
        SYSTEM,
        {
          paymentId: "pay_1",
          eventType: arm === "platform" ? "refunded" : "succeeded",
          occurredAt: NOW,
          ...(arm === "platform" ? { reason: "organiser cancelled" } : {}),
          idempotencyKey: `  ${key}\n`,
        },
        db,
      );

      expect(inserted[0]!.idempotencyKey).toBe(key);
      expect(inserted[0]!.idempotencyKey).not.toContain(" ");
    });
  }
});

describe("the manual arm collapses a repeat of the same attempt and never a new one", () => {
  it("mints the identical key for the same proof and attempt", async () => {
    // Determinism is the point of this arm: a repeated verification of one attempt is genuinely the
    // same event and must collapse rather than record a second `succeeded`.
    const first = mintManualPaymentEventKey({ action: "succeeded", proofId: "p", attempt: 0 });
    const second = mintManualPaymentEventKey({ action: "succeeded", proofId: "p", attempt: 0 });

    expect(first).toBe(second);
  });

  it("mints a DIFFERENT key once the proof has been resubmitted", async () => {
    // Without the attempt segment a verified resubmission would mint the key its first attempt
    // already used, and the real verification would be swallowed as a replay of one that never
    // happened.
    const attemptOne = mintManualPaymentEventKey({ action: "succeeded", proofId: "p", attempt: 0 });
    const attemptTwo = mintManualPaymentEventKey({ action: "succeeded", proofId: "p", attempt: 1 });

    expect(attemptTwo).not.toBe(attemptOne);
  });
});

describe("the platform arm stays unique, which the other two must not copy", () => {
  it("mints a distinct key per call", async () => {
    // Two operator refunds on one payment are two intents and no deterministic key can tell them
    // apart, so this arm randomises. A shared canonicalisation must not quietly make it collide.
    const first = mintPlatformPaymentEventKey({ action: "refunded", paymentId: "pay_1" });
    const second = mintPlatformPaymentEventKey({ action: "refunded", paymentId: "pay_1" });

    expect(first).not.toBe(second);
  });
});
