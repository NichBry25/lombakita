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
  mintManualExpiryEventKey,
  mintManualPaymentEventKey,
  mintPlatformPaymentEventKey,
  PaymentIdempotencyKeyError,
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

  it("stays impossible from the OTHER side: the verification arm cannot emit `once`", () => {
    // The collision test above fails if `once` changes. THIS one fails if `attempt` validation is
    // relaxed, which is the same invariant broken from the file that does not mention the expiry
    // minter in its code. Without this, someone widening `attempt` to accept a string would see
    // every test pass and would have reintroduced the collision.
    expect(() =>
      mintManualPaymentEventKey({
        action: "expired",
        proofId: "pay_1",
        // The exact value that would produce a byte-identical expiry key. Cast because the type
        // already forbids it, and the cast is what lets the test assert the RUNTIME check exists, so
        // the guarantee does not rest on a compile-time signature a caller can widen.
        attempt: "once" as unknown as number,
      }),
    ).toThrow(PaymentIdempotencyKeyError);
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

describe("mintManualPaymentEventKey", () => {
  it("is DETERMINISTIC for one attempt at one proof, so a repeated verify collapses", () => {
    // The opposite of the platform arm, and correctly so. A proof leaves pending_review exactly
    // once per revision (the CAS enforces it), so a repeated verification of the same attempt IS
    // the same event and must not record a second `succeeded`.
    const first = mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 0 });
    const second = mintManualPaymentEventKey({
      action: "succeeded",
      proofId: "proof_1",
      attempt: 0,
    });

    expect(first).toBe(second);
    expect(first).toBe("mn:succeeded:proof_1:0");
  });

  it("mints a DIFFERENT key for a later attempt on the same proof", () => {
    // Without the attempt segment, a proof that was rejected, resubmitted and then verified would
    // mint the key its first attempt already used, and the real verification would be swallowed as
    // a replay of a verification that never happened.
    const first = mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 0 });
    const second = mintManualPaymentEventKey({
      action: "succeeded",
      proofId: "proof_1",
      attempt: 1,
    });

    expect(first).not.toBe(second);
  });

  it("separates proofs and actions", () => {
    const a = mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 0 });
    const b = mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_2", attempt: 0 });
    const c = mintManualPaymentEventKey({ action: "expired", proofId: "proof_1", attempt: 0 });

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("refuses a negative or fractional attempt", () => {
    expect(() =>
      mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: -1 }),
    ).toThrow(PaymentIdempotencyKeyError);
    expect(() =>
      mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 1.5 }),
    ).toThrow(PaymentIdempotencyKeyError);
  });

  it("refuses a proof id carrying the separator, which would shift every field right", () => {
    expect(() =>
      mintManualPaymentEventKey({ action: "succeeded", proofId: "proof:1", attempt: 0 }),
    ).toThrow(PaymentIdempotencyKeyError);
  });

  it("produces a key appendPaymentEvent will accept", () => {
    expect(
      isPaymentEventIdempotencyKey(
        mintManualPaymentEventKey({ action: "succeeded", proofId: "proof_1", attempt: 0 }),
      ),
    ).toBe(true);
  });
});

describe("mintManualExpiryEventKey", () => {
  it("is DETERMINISTIC, so a re-visited overdue payment collapses onto one expired event", () => {
    // The sweep is scheduled, so the same payment can be reached twice: by a retry, an overlapping
    // run, or a redeploy re-registering the schedule. A second visit must land on the first event
    // rather than append a second `expired` to a ledger with no delete path.
    const first = mintManualExpiryEventKey({ paymentId: "pay_1" });
    const second = mintManualExpiryEventKey({ paymentId: "pay_1" });

    expect(first).toBe(second);
    expect(first).toBe("mn:expired:pay_1:once");
  });

  it("separates payments", () => {
    expect(mintManualExpiryEventKey({ paymentId: "pay_1" })).not.toBe(
      mintManualExpiryEventKey({ paymentId: "pay_2" }),
    );
  });

  it("CANNOT collide with a verification key, even when every other segment is made equal", () => {
    // The adversarial case, constructed rather than assumed: same `mn:` prefix, same `expired`
    // action, and the same id in the third slot. Only the last segment differs, and that is the
    // entire guarantee (see the minter's docblock). `attempt` is validated as an integer, so no
    // verification key can ever end in `once`.
    const sharedId = "expired";

    const expiry = mintManualExpiryEventKey({ paymentId: sharedId });
    const verification = mintManualPaymentEventKey({
      action: "expired",
      proofId: sharedId,
      attempt: 0,
    });

    expect(expiry).not.toBe(verification);
    expect(expiry.split(":").at(-1)).toBe("once");
    expect(verification.split(":").at(-1)).toBe("0");
  });

  it("refuses a payment id carrying the separator", () => {
    expect(() => mintManualExpiryEventKey({ paymentId: "pay:1" })).toThrow(
      PaymentIdempotencyKeyError,
    );
  });

  it("adds no fourth arm, so the key validates through the existing manual prefix", () => {
    // A FOURTH MINTING FUNCTION, NOT A FOURTH ARM. If this ever needed its own branch in
    // `isPaymentEventIdempotencyKey`, the convention would have grown a prefix and the DEC-0151 /
    // DEC-0172 shape would no longer be three.
    const key = mintManualExpiryEventKey({ paymentId: "pay_1" });

    expect(isPaymentEventIdempotencyKey(key)).toBe(true);
    expect(key.startsWith("mn:")).toBe(true);
    expect(key.split(":")).toHaveLength(4);
  });
});
