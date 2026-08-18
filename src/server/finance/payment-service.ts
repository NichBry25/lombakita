import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/payment-service");

import { and, asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  financePaymentEvents,
  financePayments,
  type FinancePaymentEventRecord,
  type FinancePaymentRecord,
} from "@/server/db/schema";
import { computePlatformFee } from "@/lib/finance/fee";
import { isIso4217Code, isMinorUnitAmount, isSupportedCurrency } from "@/lib/finance/money";
import {
  REASON_REQUIRED_EVENT_TYPES,
  SIGNED_AMOUNT_EVENT_TYPES,
  type PaymentEventActorType,
  type PaymentEventType,
  type PaymentOrigin,
} from "@/lib/finance/payment-model";
import { assertInstitutionVerified } from "@/server/competitions/competition-access";
import {
  comparePaymentEvents,
  foldPaymentEvents,
  type PaymentDerivedState,
} from "@/lib/finance/payment-state";
import { resolveFeeRule, toFeeRuleTerms } from "@/server/finance/fee-rule-service";
import { isPaymentEventIdempotencyKey } from "@/server/finance/idempotency-key";

// THE WRITE SURFACE OF THE FINANCE LEDGER, AND ALL OF IT.
//
// There is no update path and no delete path here, for payments or for events, and there must
// never be one (DEC-0133): the ledger is append-only, a correction is a compensating event, and a
// refund is a reversing event. `payment-service.append-only.test.ts` asserts this module's exported
// surface and its source, so adding an update would fail a test rather than pass unnoticed.
//
// Nothing here is reachable over HTTP. These functions are server-only and are called from trusted
// server code, which is also where the event ACTOR is derived — an actor is never read from a
// request body, and `appendPaymentEvent` takes it as a positional argument so that it cannot be.

const IDEMPOTENCY_CONSTRAINT = "finance_payment_events_idempotency_key_idx";
const ACTOR_CONSTRAINT = "finance_payment_events_actor_user_id_fk";

export type PaymentErrorCode =
  | "payment_currency_unsupported"
  | "payment_gross_amount_invalid"
  | "payment_due_at_required"
  | "payment_due_at_not_applicable"
  | "payment_fee_rule_not_found"
  | "payment_fee_rule_currency_mismatch"
  | "payment_not_found"
  | "payment_event_amount_invalid"
  | "payment_event_currency_mismatch"
  | "payment_event_reason_required"
  | "payment_event_actor_invalid"
  | "payment_event_actor_unknown"
  | "payment_event_idempotency_key_required"
  | "payment_event_idempotency_key_malformed"
  | "payment_event_idempotency_key_conflict";

export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * A database failure this lane could not classify, restated without the statement that caused it.
 *
 * Drizzle's `DrizzleQueryError` carries `Failed query: <sql>\nparams: <bound values>` as its
 * MESSAGE, which is the field an error reporter uses as the issue title. For every other service
 * that is noise; here the bound values are a payer's id, an institution's id, and the exact amount
 * they paid. This error carries the SQLSTATE and the constraint — enough to diagnose which rule
 * refused the write — and deliberately does NOT chain the original as `cause`, because a reporter
 * walks the cause chain and would recover the values that way.
 */
export class PaymentDatabaseError extends Error {
  constructor(
    public readonly operation: string,
    public readonly sqlState: string | null,
    public readonly constraint: string | null,
  ) {
    super(
      `Database refused ${operation} (sqlstate ${sqlState ?? "unknown"}, constraint ${constraint ?? "none"})`,
    );
    this.name = "PaymentDatabaseError";
  }
}

type DriverError = { code?: string; constraint?: string; constraint_name?: string };

/**
 * Finds the driver error inside whatever Drizzle threw.
 *
 * Drizzle wraps a failed query in a `DrizzleQueryError` whose `message` is the SQL and whose
 * `cause` is the postgres-js error carrying the SQLSTATE. Reading `error.code` directly therefore
 * returns undefined against a real database — the check compiles, runs, matches nothing, and the
 * duplicate-key branch below silently never fires. Walking the cause chain handles both the
 * wrapped and unwrapped shapes.
 */
const findDriverError = (error: unknown): DriverError | null => {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as DriverError & { cause?: unknown };
    if (typeof candidate.code === "string") {
      return candidate;
    }
    current = candidate.cause;
  }

  return null;
};

const constraintOf = (error: unknown): string | null => {
  const driver = findDriverError(error);
  return driver?.constraint_name ?? driver?.constraint ?? null;
};

const isForeignKeyViolation = (error: unknown): boolean => findDriverError(error)?.code === "23503";

/** Restates a database failure without the SQL or the values that were bound into it. */
const asDatabaseError = (error: unknown, operation: string): PaymentDatabaseError =>
  new PaymentDatabaseError(operation, findDriverError(error)?.code ?? null, constraintOf(error));

// A payment's subject. One variant per shipped subject type; a new subject type is added here and
// on the table's XOR CHECK together.
export type PaymentSubject = {
  type: "competition_registration";
  competitionRegistrationId: string;
};

export type CreatePaymentInput = {
  payerUserId: string;
  // NOT NULL by design (DEC-0130). A payment that cannot name its recipient would be one the
  // platform is implicitly holding, which this system must be unable to express.
  receivingInstitutionId: string;
  subject: PaymentSubject;
  grossAmount: number;
  currency: string;
  // The instant the fee rule is resolved against. Explicit so a caller replaying a historical
  // payment prices it under the rule that was in force THEN.
  pricedAt: Date;
  // Which lane carries the money. Required, with no default, because the fee columns below mean
  // different things per lane and a caller that has not thought about which one it is on is a
  // caller that should not be recording a payment.
  origin: PaymentOrigin;
  // The deadline this payment is being given, already resolved by the caller through
  // `resolvePaymentDueAt` (which clamps it to registration close). Required on the manual lane and
  // rejected on the gateway lane, where the provider owns expiry. SNAPSHOTTED: nothing recomputes
  // it, so editing the competition's window never moves a deadline already handed out.
  dueAt?: Date | null;
};

/**
 * Records a payment, pricing it under the fee rule in force at `pricedAt` and SNAPSHOTTING the
 * result onto the row.
 *
 * The snapshot is the point. `fee_rule_id` records only which rule priced this payment; every
 * figure that matters — basis points, flat component, platform fee, gross, net, currency — is
 * copied here at creation and is never recomputed from the rule again. Editing a fee rule next
 * month therefore cannot restate what was recorded last month.
 */
export const createPayment = async (
  input: CreatePaymentInput,
  db: Database = getDb(),
): Promise<FinancePaymentRecord> => {
  if (!isSupportedCurrency(input.currency)) {
    throw new PaymentError(
      "payment_currency_unsupported",
      `Currency ${input.currency} is not supported`,
    );
  }

  if (!isMinorUnitAmount(input.grossAmount) || input.grossAmount < 0) {
    throw new PaymentError(
      "payment_gross_amount_invalid",
      "Gross amount must be a non-negative integer minor-unit value",
    );
  }

  const dueAt = input.dueAt ?? null;

  if (input.origin === "manual_transfer" && dueAt === null) {
    throw new PaymentError(
      "payment_due_at_required",
      "A manual-transfer payment must carry the deadline it was given — resolve it with resolvePaymentDueAt",
    );
  }

  if (input.origin !== "manual_transfer" && dueAt !== null) {
    // The gateway owns expiry on its own lane. A second deadline recorded here would be one nothing
    // enforces, sitting next to the one that is actually binding.
    throw new PaymentError(
      "payment_due_at_not_applicable",
      "Only a manual-transfer payment carries a due date — the gateway owns expiry on its lane",
    );
  }

  // THE CHARGING GATE, fail-closed backstop (DEC-0158). This is the LAST place money can be
  // refused, and it is deliberately here rather than only at the surfaces that lead here: a future
  // checkout flow, a webhook, or a script that reaches createPayment without passing the earlier
  // gates still cannot charge on behalf of an unverified institution.
  //
  // Gated on a PRICED payment, not on every payment. `finance_payments` accepts gross = 0 for a
  // free registration, and refusing those would make an unverified institution unable to run the
  // free competitions DEC-0158 explicitly permits it to run.
  if (input.grossAmount > 0) {
    await assertInstitutionVerified(input.receivingInstitutionId, db);
  }

  const rule = await resolveFeeRule(input.receivingInstitutionId, input.pricedAt, db);

  if (!rule) {
    throw new PaymentError(
      "payment_fee_rule_not_found",
      `No fee rule is in force for institution ${input.receivingInstitutionId}`,
    );
  }

  const terms = toFeeRuleTerms(rule);

  if (terms.currency !== input.currency) {
    throw new PaymentError(
      "payment_fee_rule_currency_mismatch",
      `Fee rule ${rule.id} is denominated in ${terms.currency}, payment is in ${input.currency}`,
    );
  }

  const fee = computePlatformFee(input.grossAmount, terms);

  // THE MANUAL LANE SPLITS NOTHING. The payer transferred the whole amount into the institution's
  // own account, so the truthful record is fee 0 / net = gross; the platform's fee on this payment
  // is a separate debt recorded in `finance_fee_accruals` once the transfer is verified. The
  // computed `fee` above is still what prices that accrual — it is not discarded, it is just not
  // what this row describes. A database CHECK enforces the same rule, so a future caller that
  // writes the split directly is refused rather than quietly recording a fee that never moved.
  const isManualLane = input.origin === "manual_transfer";
  const platformFeeAmount = isManualLane ? 0 : fee.platformFeeAmount;
  const institutionNetAmount = isManualLane ? fee.grossAmount : fee.institutionNetAmount;

  let payment: FinancePaymentRecord | undefined;

  try {
    [payment] = await db
      .insert(financePayments)
      .values({
        payerUserId: input.payerUserId,
        receivingInstitutionId: input.receivingInstitutionId,
        subjectType: input.subject.type,
        competitionRegistrationId: input.subject.competitionRegistrationId,
        currency: input.currency,
        origin: input.origin,
        grossAmount: fee.grossAmount,
        feeRuleId: rule.id,
        feeBasisPoints: fee.feeBasisPoints,
        feeFlatAmount: fee.feeFlatAmount,
        platformFeeAmount,
        institutionNetAmount,
        dueAt: dueAt,
      })
      .returning();
  } catch (error) {
    // This insert binds the payer, the recipient and every figure of the split in one statement, so
    // an unwrapped driver error would carry all of it into whatever reports the failure.
    throw asDatabaseError(error, "recording a payment");
  }

  if (!payment) {
    throw new Error("Payment insert returned no row");
  }

  return payment;
};

/**
 * Who caused an event.
 *
 * This is a POSITIONAL parameter of `appendPaymentEvent`, deliberately not a field on its input
 * object, and the distinction is the whole guarantee. Every other field a caller passes — amount,
 * reason, metadata, the idempotency key — legitimately comes from a gateway payload or a request
 * body, so an actor sitting among them is one `appendPaymentEvent({ ...body })` away from being
 * caller-asserted, and that call would type-check, satisfy the actor CHECK, and write a forged
 * attribution onto a refund. A positional argument cannot be supplied by an object spread, so the
 * caller has to name the actor and the obvious thing to reach for is the session it already
 * resolved. This mirrors `suspendUser(actorUserId, …)` and `createNote(…, actorUserId, …)`.
 *
 * `userId?: undefined` on the non-user arm is load-bearing: it makes `{ type: "gateway", userId }`
 * a type error rather than a value silently dropped.
 */
export type PaymentEventActor =
  | { type: Exclude<PaymentEventActorType, "user">; userId?: undefined }
  | { type: "user"; userId: string };

export type AppendPaymentEventInput = {
  paymentId: string;
  eventType: PaymentEventType;
  occurredAt: Date;
  // Monetary events carry both; non-monetary events carry neither.
  amount?: number | null;
  currency?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  // The replay guard. Enforced by a unique index — a second append under the same key returns the
  // first event rather than recording a second one. MUST come from `mintGatewayPaymentEventKey`
  // (deterministic, so a webhook retry collapses) or `mintPlatformPaymentEventKey` (unique, so a
  // second refund is a second event); see server/finance/idempotency-key.ts. A hand-built key is
  // refused — the two halves have opposite requirements and mixing them loses either replay
  // protection or a real event.
  idempotencyKey: string;
};

export type AppendPaymentEventResult = {
  event: FinancePaymentEventRecord;
  // True when this key had already been recorded, so nothing new was written.
  deduplicated: boolean;
};

const assertEventInput = (
  actor: PaymentEventActor,
  input: AppendPaymentEventInput,
  idempotencyKey: string,
): void => {
  if (idempotencyKey.length === 0) {
    throw new PaymentError(
      "payment_event_idempotency_key_required",
      "An idempotency key is required for every payment event",
    );
  }

  // The convention is enforced here, not just written down. The key space is global
  // and its two halves have opposite requirements — a gateway key must be reproducible, a platform
  // key must not be — so a hand-built key is not a style question: `refunded__<paymentId>` collides
  // by construction on the second refund of one payment, and the first thing that would notice is
  // an operator wondering why a refund they issued is not in the ledger. Refusing at the write is
  // what keeps the two halves from being mixed by a caller who did not read the module.
  if (!isPaymentEventIdempotencyKey(idempotencyKey)) {
    throw new PaymentError(
      "payment_event_idempotency_key_malformed",
      "Idempotency keys must be minted by mintGatewayPaymentEventKey or mintPlatformPaymentEventKey (see server/finance/idempotency-key.ts)",
    );
  }

  const amount = input.amount ?? null;
  const currency = input.currency ?? null;

  if ((amount === null) !== (currency === null)) {
    throw new PaymentError(
      "payment_event_currency_mismatch",
      "A payment event carries an amount and a currency together, or neither",
    );
  }

  if (amount !== null) {
    if (!isMinorUnitAmount(amount)) {
      throw new PaymentError(
        "payment_event_amount_invalid",
        "Amount must be an integer minor-unit value",
      );
    }

    if (amount < 0 && !SIGNED_AMOUNT_EVENT_TYPES.includes(input.eventType)) {
      throw new PaymentError(
        "payment_event_amount_invalid",
        `A ${input.eventType} event cannot carry a negative amount`,
      );
    }
  }

  if (currency !== null && (!isIso4217Code(currency) || !isSupportedCurrency(currency))) {
    throw new PaymentError(
      "payment_event_currency_mismatch",
      `Currency ${currency} is not a supported ISO-4217 code`,
    );
  }

  if (
    REASON_REQUIRED_EVENT_TYPES.includes(input.eventType) &&
    (input.reason ?? "").trim().length === 0
  ) {
    throw new PaymentError(
      "payment_event_reason_required",
      `A ${input.eventType} event must state its reason`,
    );
  }

  if (actor.type === "user" && actor.userId.trim().length === 0) {
    throw new PaymentError(
      "payment_event_actor_invalid",
      "A user-actor event must name the acting user",
    );
  }
};

/**
 * Appends one event to a payment's ledger.
 *
 * Idempotency is the database's unique index on `idempotency_key`, not a read-then-insert check.
 * The insert is attempted unconditionally and the index decides: `ON CONFLICT DO NOTHING` targeted
 * at that index returns no row when the key has already been recorded, and the existing event is
 * read back as `deduplicated: true`. A read-first check would leave the window between the read and
 * the insert wide open, which is exactly the race an idempotency key exists to close.
 *
 * ON CONFLICT rather than catching the 23505 it would otherwise raise, because a raised constraint
 * violation ABORTS the surrounding transaction — the follow-up SELECT would then fail with 25P02,
 * so a caller appending inside a transaction (which every real caller will be) could never be
 * handed the existing row. The unique index is doing the same work either way; this is the form
 * that survives being called in a transaction.
 */
export const appendPaymentEvent = async (
  actor: PaymentEventActor,
  input: AppendPaymentEventInput,
  db: Database = getDb(),
): Promise<AppendPaymentEventResult> => {
  // ONE canonical form of the key, derived once and used by the check, the insert and the readback.
  // Validating a trimmed value while storing the raw one lets a padded key pass the check and land
  // in the table with its padding: the retry then mints the canonical form, the unique index sees a
  // different string, `ON CONFLICT` does not fire, and one gateway event is recorded twice in a
  // ledger that has no delete path. Three uses of one value is what makes the index's guarantee and
  // this function's guarantee the same guarantee.
  const idempotencyKey = input.idempotencyKey.trim();

  assertEventInput(actor, input, idempotencyKey);

  const values = {
    paymentId: input.paymentId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    actorType: actor.type,
    actorUserId: actor.type === "user" ? actor.userId : null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    idempotencyKey,
  };

  let inserted: FinancePaymentEventRecord | undefined;

  try {
    [inserted] = await db
      .insert(financePaymentEvents)
      .values(values)
      .onConflictDoNothing({ target: financePaymentEvents.idempotencyKey })
      .returning();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      // The table has two foreign keys. Reporting a missing payment when the ACTOR is the unknown
      // one would mask the more interesting fault: an actor id that fails its key is the signal
      // that an actor value came from somewhere it should not have.
      if (constraintOf(error) === ACTOR_CONSTRAINT) {
        throw new PaymentError(
          "payment_event_actor_unknown",
          "The acting user named on this event does not exist",
        );
      }

      throw new PaymentError("payment_not_found", `Payment ${input.paymentId} does not exist`);
    }

    throw asDatabaseError(error, "appending a payment event");
  }

  if (inserted) {
    return { event: inserted, deduplicated: false };
  }

  const [existing] = await db
    .select()
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.idempotencyKey, idempotencyKey))
    .limit(1);

  if (!existing) {
    // The index refused the insert but nothing is there to return. Unreachable under READ
    // COMMITTED, which this codebase depends on throughout: a caller blocked by an uncommitted
    // duplicate that then rolls back proceeds and inserts rather than arriving here. A stricter
    // isolation level raises 40001 before reaching this line. Reporting success would invent an
    // event that does not exist.
    throw new Error(
      `Payment event conflicted on ${IDEMPOTENCY_CONSTRAINT} but could not be read back`,
    );
  }

  // The key is unique GLOBALLY, not per payment, so a suppressed insert proves only that this key
  // was used before — not that it was used for this. Without this check the caller is handed
  // whatever row owns the key, for any payment and any institution, and told `deduplicated: true`
  // while its own event is silently discarded: an event that does not exist in an append-only
  // ledger, and another tenant's amount, reason and actor returned in its place. A replay must
  // match what it claims to replay, or it is not a replay.
  if (
    existing.paymentId !== input.paymentId ||
    existing.eventType !== input.eventType ||
    existing.amount !== (input.amount ?? null)
  ) {
    // Deliberately describes only what the caller supplied. Naming the stored row's payment,
    // amount or reason here would disclose the very thing the check exists to withhold.
    throw new PaymentError(
      "payment_event_idempotency_key_conflict",
      `This idempotency key is already recorded against a different event; it cannot be reused for a ${input.eventType} event on payment ${input.paymentId}`,
    );
  }

  return { event: existing, deduplicated: true };
};

export type PaymentLedger = {
  payment: FinancePaymentRecord;
  events: FinancePaymentEventRecord[];
  state: PaymentDerivedState;
};

/**
 * Loads one payment and folds its events into its current state.
 *
 * `institutionId` is REQUIRED and every query filters on it. A reader over institution-scoped
 * finance rows that takes no scope is a cross-tenant read waiting for its first caller, so the
 * scope is a parameter rather than something the caller is trusted to apply afterwards. A payment
 * belonging to another institution is indistinguishable from one that does not exist: null.
 */
export const loadPaymentLedger = async (
  institutionId: string,
  paymentId: string,
  db: Database = getDb(),
): Promise<PaymentLedger | null> => {
  const [payment] = await db
    .select()
    .from(financePayments)
    .where(
      and(
        eq(financePayments.id, paymentId),
        eq(financePayments.receivingInstitutionId, institutionId),
      ),
    )
    .limit(1);

  if (!payment) {
    return null;
  }

  // Filtered on the id of the row ALREADY PROVEN to belong to this institution, not on the
  // caller's parameter, so no later edit to how `paymentId` is handled can reopen the events path.
  const events = await db
    .select()
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, payment.id))
    .orderBy(
      asc(financePaymentEvents.occurredAt),
      asc(financePaymentEvents.recordedAt),
      asc(financePaymentEvents.id),
    );

  // Sorted again by the same comparator the fold uses, so the returned list and the folded state
  // are ordered identically no matter what the query planner did.
  const ordered = [...events].sort(comparePaymentEvents);

  return { payment, events: ordered, state: foldPaymentEvents(ordered) };
};
