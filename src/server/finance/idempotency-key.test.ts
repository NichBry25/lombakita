// @vitest-environment node
//
// The two halves of the key convention have OPPOSITE requirements, and these tests
// are written to fail if either is quietly given the other's behaviour: a gateway key that stops
// being reproducible silently duplicates every webhook retry, and a platform key that becomes
// reproducible silently loses the second refund.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  isPaymentEventIdempotencyKey,
  mintGatewayPaymentEventKey,
  mintPlatformPaymentEventKey,
} from "./idempotency-key";

describe("mintGatewayPaymentEventKey", () => {
  it("is deterministic, so a webhook retry collapses onto one row", () => {
    const args = {
      provider: "xendit",
      eventType: "succeeded",
      providerEventId: "evt_abc",
    } as const;

    expect(mintGatewayPaymentEventKey(args)).toBe(mintGatewayPaymentEventKey(args));
    expect(mintGatewayPaymentEventKey(args)).toBe("gw:xendit:succeeded:evt_abc");
  });

  it("namespaces by provider, so two gateways issuing the same event id do not collide", () => {
    // The index is global. Without the provider segment the second provider's `evt_1` would be
    // swallowed as a replay of the first's.
    const key = mintGatewayPaymentEventKey({
      provider: "xendit",
      eventType: "succeeded",
      providerEventId: "evt_1",
    });

    expect(key.startsWith("gw:xendit:")).toBe(true);
  });

  it("separates the ledger events one delivery raises, so neither is lost to a false replay", () => {
    // The case the three-segment shape could not express: one webhook delivery, two ledger events.
    // Without this segment both appends compete for one key and the second is silently swallowed.
    const shared = { provider: "xendit", providerEventId: "evt_7" } as const;

    expect(mintGatewayPaymentEventKey({ ...shared, eventType: "succeeded" })).not.toBe(
      mintGatewayPaymentEventKey({ ...shared, eventType: "refunded" }),
    );
  });

  it("refuses an event id carrying the separator rather than sanitising it", () => {
    // Sanitising would break determinism — the same gateway event id must always produce the same
    // key — and a `:` would shift every field right, letting a crafted id impersonate another key.
    expect(() =>
      mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: "evt:1",
      }),
    ).toThrow(/providerEventId/);
  });

  it("refuses an empty event id", () => {
    expect(() =>
      mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: "  ",
      }),
    ).toThrow(/providerEventId/);
  });

  it("names the failing segment and never the value that failed, which arrives over a webhook", () => {
    // An error message is the field a reporter uses as an issue title. A provider event id is
    // caller-controlled payload data, so interpolating it there ships gateway contents to Sentry.
    const crafted = "evt:secret-payload-value";

    expect(() =>
      mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: crafted,
      }),
    ).toThrow(expect.objectContaining({ code: "payment_event_idempotency_key_unmintable" }));

    try {
      mintGatewayPaymentEventKey({
        provider: "xendit",
        eventType: "succeeded",
        providerEventId: crafted,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-payload-value");
      expect((error as Error).message).toContain("providerEventId");
    }
  });
});

describe("mintPlatformPaymentEventKey", () => {
  it("is unique per call, so a second refund on one payment is a second event", () => {
    const paymentId = "pay_1";

    const first = mintPlatformPaymentEventKey({ action: "refunded", paymentId });
    const second = mintPlatformPaymentEventKey({ action: "refunded", paymentId });

    // A deterministic key built from (payment, verb) makes these
    // equal, and the second genuine refund is then swallowed or refused.
    expect(first).not.toBe(second);
  });

  it("names its payment so a key found in an incident can be traced without a join", () => {
    const key = mintPlatformPaymentEventKey({ action: "corrected", paymentId: "pay_9" });

    expect(key.startsWith("pf:corrected:pay_9:")).toBe(true);
  });

  it("refuses a payment id carrying the separator", () => {
    expect(() => mintPlatformPaymentEventKey({ action: "refunded", paymentId: "pay:1" })).toThrow(
      /paymentId/,
    );
  });
});

describe("isPaymentEventIdempotencyKey", () => {
  it("accepts keys from both minting functions", () => {
    expect(
      isPaymentEventIdempotencyKey(
        mintGatewayPaymentEventKey({
          provider: "xendit",
          eventType: "succeeded",
          providerEventId: "evt_1",
        }),
      ),
    ).toBe(true);
    expect(
      isPaymentEventIdempotencyKey(
        mintPlatformPaymentEventKey({ action: "refunded", paymentId: "pay_1" }),
      ),
    ).toBe(true);
  });

  it("rejects the hand-built key that collides by construction", () => {
    // This is what a caller reaches for without reading the module, and it is the whole reason
    // `appendPaymentEvent` calls this function rather than trusting the convention to be followed.
    expect(isPaymentEventIdempotencyKey("refund__pay_1")).toBe(false);
    expect(isPaymentEventIdempotencyKey("refunded:pay_1")).toBe(false);
  });

  it("rejects a key with the wrong number of segments for its origin", () => {
    // A gateway key with a UUID appended would be non-reproducible while claiming to be a gateway
    // key — the exact swap that destroys webhook replay protection.
    expect(isPaymentEventIdempotencyKey("gw:xendit:succeeded:evt_1:extra")).toBe(false);
    expect(isPaymentEventIdempotencyKey("gw:xendit:evt_1")).toBe(false);
    expect(isPaymentEventIdempotencyKey("pf:refunded:pay_1")).toBe(false);
  });

  it("rejects an unknown origin prefix", () => {
    expect(isPaymentEventIdempotencyKey("xx:xendit:succeeded:evt_1")).toBe(false);
    expect(isPaymentEventIdempotencyKey("")).toBe(false);
  });
});
