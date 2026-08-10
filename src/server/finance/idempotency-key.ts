import { randomUUID } from "node:crypto";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import type { PaymentEventType } from "@/lib/finance/payment-model";

assertServerOnly("server/finance/idempotency-key");

// THE IDEMPOTENCY-KEY CONVENTION FOR finance_payment_events.
//
// `finance_payment_events.idempotency_key` is unique GLOBALLY — one namespace shared by every
// payment in the system — so a key is not merely "some string the caller picked". It has to be
// unique across everything at once, and it has to be REPRODUCIBLE exactly when a replay should
// collapse and NEVER reproducible when it should not. Those two requirements pull in opposite
// directions, which is why there are two minting functions here rather than one.
//
// The convention:
//
//   gateway-originated   gw:<provider>:<eventType>:<providerEventId>
//   platform-originated  pf:<action>:<paymentId>:<uuid>
//
// A GATEWAY key is DETERMINISTIC, derived from the provider's own event id. That is the entire
// point: a webhook retry storm delivers the same event id many times, every delivery mints the same
// key, and the unique index collapses them to one row. A random key here would record the same
// captured payment five times.
//
// The `<eventType>` segment is the LEDGER event type, not the provider's. One webhook delivery can
// legitimately raise more than one ledger event, and without this segment those two appends would
// compete for a single key: the second collapses into the first as a false replay and is silently
// never recorded. Typing it as `PaymentEventType` is what makes that structural rather than a
// convention a caller has to remember.
//
// WHAT `providerEventId` MUST BE — the requirement, deliberately stated without naming a field.
// It must be a value the provider guarantees is IDENTICAL across every retry of one event and
// DISTINCT across different events. That is a property of the provider's delivery semantics, not a
// choice this module can make. The two ways to get it wrong are symmetrical and both end in money
// the ledger does not describe: bind it to an OBJECT id (the invoice) and a later refund on that
// invoice collides with the original capture, so the refund is swallowed; bind it to a value that
// ROTATES per delivery attempt and the same capture records once per retry. Which Xendit field
// satisfies this cannot be confirmed from documentation alone and there is no account to verify it
// against yet, so it is an ENTRY OBLIGATION (FINANCE-D23) on whichever step writes the first
// webhook handler: the binding is chosen and proven against real deliveries before that handler
// exists, never inferred at the keyboard.
//
// A PLATFORM key is UNIQUE, carrying a minted UUID. That is equally the point: a deterministic
// platform key of the obvious shape — `refunded__<paymentId>`, or anything else built only from the
// payment and the verb — COLLIDES BY CONSTRUCTION on the second partial refund of one payment. The
// second refund would be silently swallowed as a replay of the first and, since the readback
// compares amounts, more likely refused outright with `payment_event_idempotency_key_conflict`.
// Either way the money moved and the ledger does not say so. There is no deterministic function of (payment, verb) that distinguishes two genuine refunds,
// because nothing about them differs except the operator's intent to issue a second one.
//
// The consequence a caller must own: a platform key gives NO replay protection, because two
// identical operator requests are two intents and no key can tell them apart. A caller that needs
// an operator's double-submit to be idempotent must mint the key ONCE, carry it through its own
// retries, and reuse it — the same discipline a payment form uses for a client-supplied
// idempotency key. Minting a fresh key inside a retry loop records a second event.

/**
 * Payment providers whose event ids can namespace a key.
 *
 * A single-member union today, and deliberately not widened in advance. It exists as a segment at
 * all because the index is global: two providers can independently issue the event id `evt_1`, and
 * without the namespace the second one to arrive would be swallowed as a replay of the first.
 */
export type PaymentGateway = "xendit";

/**
 * The platform-originated actions that can raise an event.
 *
 * Constrained to the two event types a human operator can originate. `initiated` / `succeeded` /
 * `failed` / `expired` describe what a gateway observed and belong on the gateway arm; typing this
 * as the full `PaymentEventType` would invite a caller to mint a random-suffixed key for a gateway
 * event and quietly destroy that event's replay protection.
 */
export type PlatformPaymentAction = Extract<PaymentEventType, "refunded" | "corrected">;

export const GATEWAY_KEY_PREFIX = "gw";
export const PLATFORM_KEY_PREFIX = "pf";

// The alphabet already accepted by `sanitizeIdempotencyKey` for BullMQ job ids. Reused rather than
// invented so one idea keeps one shape across the codebase; `:` is the separator in both.
const KEY_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * A key that could not be minted from the values it was given.
 *
 * Restated rather than raw, following the same rule as this lane's database errors: the message
 * names the SEGMENT that failed and never the value that failed it. A provider event id is
 * caller-controlled data arriving over a webhook, and an error message is the field a reporter uses
 * as an issue title — interpolating it there is how gateway payload contents end up in Sentry.
 *
 * The code is what makes it actionable. A 7.2 webhook handler has to tell two situations apart: a
 * provider event id this convention cannot express (`unmintable` — the delivery is real, the key is
 * not, and the event needs a dead-letter path rather than a retry) and a bug in its own calling
 * code. A bare `Error` collapses both into "something threw".
 */
export class PaymentIdempotencyKeyError extends Error {
  public readonly code = "payment_event_idempotency_key_unmintable" as const;

  constructor(public readonly segment: string) {
    super(
      `Payment event idempotency key: ${segment} is empty or contains characters outside [A-Za-z0-9_-]`,
    );
    this.name = "PaymentIdempotencyKeyError";
  }
}

const assertSegment = (value: string, label: string): string => {
  const trimmed = value.trim();

  // A segment carrying a `:` would shift every field to its right, so a crafted gateway event id
  // could impersonate a different payment's key. Refuse rather than sanitise: silently rewriting a
  // gateway's event id would break the determinism that makes the gateway arm work at all.
  if (trimmed.length === 0 || !KEY_SEGMENT_PATTERN.test(trimmed)) {
    throw new PaymentIdempotencyKeyError(label);
  }

  return trimmed;
};

/**
 * Mints the key for an event a payment gateway told us about. DETERMINISTIC — the same provider,
 * ledger event type and provider event id always produce the same key, which is what makes a webhook
 * retry collapse to one row.
 *
 * `eventType` is the LEDGER event this delivery raises, so one delivery raising two ledger events
 * mints two distinct keys rather than losing the second to a false replay. See the header for what
 * `providerEventId` has to guarantee.
 */
export const mintGatewayPaymentEventKey = (params: {
  provider: PaymentGateway;
  eventType: PaymentEventType;
  providerEventId: string;
}): string => {
  const provider = assertSegment(params.provider, "provider");
  const eventType = assertSegment(params.eventType, "eventType");
  const eventId = assertSegment(params.providerEventId, "providerEventId");

  return `${GATEWAY_KEY_PREFIX}:${provider}:${eventType}:${eventId}`;
};

/**
 * Mints the key for an event the platform itself raised. UNIQUE on every call — see the header:
 * two refunds on one payment are two events, and a key that cannot express that loses one of them.
 *
 * `paymentId` is carried even though the UUID alone would guarantee uniqueness, because a key is
 * read by a human during an incident and one that names its payment can be traced back to the
 * ledger row without a join.
 */
export const mintPlatformPaymentEventKey = (params: {
  action: PlatformPaymentAction;
  paymentId: string;
}): string => {
  const action = assertSegment(params.action, "action");
  const paymentId = assertSegment(params.paymentId, "paymentId");

  return `${PLATFORM_KEY_PREFIX}:${action}:${paymentId}:${randomUUID()}`;
};

/**
 * Whether a key was minted by one of the two functions above.
 *
 * `appendPaymentEvent` calls this, so the convention is ENFORCED rather than merely documented — a
 * convention that lives only in a comment is one a caller can violate with nothing failing. The
 * check is deliberately structural rather than exhaustive — it does not re-validate the UUID or
 * know which providers exist — because its job is to stop a hand-built `refunded__<paymentId>`
 * reaching the table, not to re-derive what the minting functions already guaranteed.
 */
export const isPaymentEventIdempotencyKey = (value: string): boolean => {
  const segments = value.split(":");

  if (segments[0] === GATEWAY_KEY_PREFIX) {
    return segments.length === 4 && segments.slice(1).every((s) => KEY_SEGMENT_PATTERN.test(s));
  }

  if (segments[0] === PLATFORM_KEY_PREFIX) {
    return segments.length === 4 && segments.slice(1).every((s) => KEY_SEGMENT_PATTERN.test(s));
  }

  return false;
};
