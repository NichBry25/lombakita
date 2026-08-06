// The closed value sets of the payment domain, declared here rather than in the Drizzle schema so
// the pure fold and the database enums cannot drift apart — schema.ts builds its pgEnums from
// these tuples, the same way `app_role` is built from APP_ROLES.
//
// Client-safe: pure, no server-only imports.

// What a payment is FOR. Each value has a matching nullable foreign key on `finance_payments`,
// and the XOR CHECK there enforces that the declared type and the populated key agree.
//
// `competition_registration` is the ONLY subject shipped, because it is the only one whose anchor
// row exists today. `institution_subscription` waits for the subscription entity to exist.
// Featured placement is deliberately absent: it is modelled as `is_featured` / `featured_order`
// COLUMNS on `competitions` rather than as an order row, so there is nothing stable for a payment
// to reference — inventing one here would be a fabricated reference, not a subject type.
export const PAYMENT_SUBJECT_TYPES = ["competition_registration"] as const;

export type PaymentSubjectType = (typeof PAYMENT_SUBJECT_TYPES)[number];

// The event stream's vocabulary. Deliberately narrow and INTERNAL: these describe what happened to
// the payment, not what a gateway called it. Gateway-specific values are added when a webhook
// genuinely needs them, never in advance.
//
//   initiated — a payment attempt was started
//   succeeded — funds moved
//   failed    — the attempt was rejected
//   expired   — the attempt lapsed without a decision
//   refunded  — money went back; a REVERSING EVENT, never an edit of the payment it reverses
//   corrected — an operator restated a figure that was recorded wrongly; carries its own reason
//               and never hides the row it corrects
export const PAYMENT_EVENT_TYPES = [
  "initiated",
  "succeeded",
  "failed",
  "expired",
  "refunded",
  "corrected",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

// Event types whose reason is mandatory. Both restate money that was already recorded, so "why"
// is the only thing that makes the restatement auditable. Enforced by a DB CHECK, not by
// politeness.
export const REASON_REQUIRED_EVENT_TYPES: readonly PaymentEventType[] = ["refunded", "corrected"];

// Event types whose amount may be negative. A correction that walks back an over-recorded figure
// has no other way to express itself in an append-only table. Everything else is non-negative.
export const SIGNED_AMOUNT_EVENT_TYPES: readonly PaymentEventType[] = ["corrected"];

// Who caused the event.
//
//   system  — this application's own server logic
//   gateway — the payment provider, via a callback
//   user    — a named human acting deliberately; `actor_user_id` is REQUIRED for this value and
//             forbidden for the others, enforced by a DB CHECK
//
// The actor is always derived server-side at the call site. It is never read from a request body,
// which is what stops an event claiming to have been raised by someone who did not raise it.
export const PAYMENT_EVENT_ACTOR_TYPES = ["system", "gateway", "user"] as const;

export type PaymentEventActorType = (typeof PAYMENT_EVENT_ACTOR_TYPES)[number];
