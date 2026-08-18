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

// HOW the money reached the institution. Both values are permanent lanes that coexist; neither is
// a placeholder for the other.
//
//   manual_transfer — the payer transfers to the institution's own bank account or QRIS and uploads
//                     a bukti transfer. The money never passes through any platform-controlled
//                     account, so NOTHING SPLITS AT TRANSACTION TIME: the institution receives the
//                     whole gross and the platform's fee becomes an ACCRUAL it owes separately.
//   gateway         — the payer pays into the institution's gateway sub-account and the platform
//                     fee splits at transaction time, so the fee columns describe money that has
//                     already moved apart.
//
// The distinction is why `finance_payments` carries a CHECK tying manual_transfer to a zero
// platform fee: the fee columns mean "what split, when this was recorded", and on the manual lane
// nothing did.
export const PAYMENT_ORIGINS = ["manual_transfer", "gateway"] as const;

export type PaymentOrigin = (typeof PAYMENT_ORIGINS)[number];

// An accrual row's direction. Append-only, so a correction is a new row rather than an edit.
//
//   accrued  — the institution owes this fee on a manual-lane payment. AT MOST ONE per payment,
//              guaranteed by a partial unique index rather than by a service read-then-write.
//   reversed — a compensating row that walks an accrual back (a proof later found invalid, an
//              operator restating a figure). Carries a non-positive amount and a mandatory reason,
//              and is deliberately UNCONSTRAINED in count: a fee can be corrected more than once.
export const FEE_ACCRUAL_ENTRY_TYPES = ["accrued", "reversed"] as const;

export type FeeAccrualEntryType = (typeof FEE_ACCRUAL_ENTRY_TYPES)[number];

// Where a bukti transfer sits in its review loop. `rejected` is not terminal — the DEC-0115
// revision loop reopens it to `pending_review`, which is why the rejection reason is retained on
// the row rather than cleared on resubmission.
export const MANUAL_PAYMENT_PROOF_STATUSES = [
  "pending_review",
  "verified",
  "rejected",
  // An operator closed the proof out without a verdict on the money (DEC-0132's escape hatch).
  // Distinct from `rejected`: nothing is being said about whether the transfer happened, so no
  // finance event is written and the revision loop does not reopen.
  "voided",
] as const;

export type ManualPaymentProofStatus = (typeof MANUAL_PAYMENT_PROOF_STATUSES)[number];

// A proof that is submitted and has not been rejected or voided — the PAYMENT IN FLIGHT arm.
// Exported as data rather than inlined so the predicate and the database index that serves it
// cannot drift apart.
export const IN_FLIGHT_PROOF_STATUSES: readonly ManualPaymentProofStatus[] = [
  "pending_review",
  "verified",
];
