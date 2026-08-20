import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/payment-expiry-service");

import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePayments,
} from "@/server/db/schema";
import { foldPaymentEvents } from "@/lib/finance/payment-state";
import { appendPaymentEvent } from "@/server/finance/payment-service";
import { mintManualExpiryEventKey } from "@/server/finance/idempotency-key";
import { notifyPaymentOutcome } from "@/server/finance/payment-notifications";
import { logger } from "@/lib/logger";

// WHAT HAPPENS WHEN A BUKTI TRANSFER DEADLINE PASSES WITH NOTHING SUBMITTED.
//
// A WORKER, not a read-time predicate, and the reason is the notification. A lazy "treat it as
// expired when someone next looks" cannot tell a candidate their registration lapsed, because
// nobody looks — the candidate who forgot to pay is exactly the candidate not opening the page.
// The event has to be written by something that runs on a clock.
//
// Why expiry matters at all, stated here so nobody re-derives it wrongly: there is NO capacity cap
// anywhere in this product, so an unpaid registration is not occupying a seat. It matters because
// it holds the unpublish block open against the organiser, and because it occupies the partial
// unique index on (student, competition) — so until it lapses, the candidate cannot register again.
//
// THE DEADLINE GOVERNS SUBMISSION, NEVER THE VERDICT. A proof sitting in `pending_review` when the
// deadline passes SUSPENDS expiry indefinitely. A candidate who transferred real money and uploaded
// their evidence in time must never be cancelled because the organiser was slow to look at it.

/**
 * The cancellation reason written on an expired registration.
 *
 * A distinct sentinel rather than prose, because `cancellation_reason` is free text with no enum
 * and every later report has to separate "the candidate withdrew" from "the platform cancelled
 * this because nobody paid". Those are opposite facts about the same column, and a human-written
 * sentence cannot be filtered on reliably.
 */
export const PAYMENT_EXPIRY_CANCELLATION_REASON = "payment_deadline_expired";

/**
 * Whether a proof awaiting a verdict is holding this payment's deadline open.
 *
 * THE SUSPENSION RULE, in one place. The worker consults it under a row lock before expiring
 * anything; the candidate's payment view consults it to decide whether to render the deadline as a
 * live countdown. A surface that derived this separately would eventually tell a candidate they
 * are safe while the worker was about to cancel them, or the reverse.
 *
 * `pending_review` only. A rejected or voided proof does NOT suspend — the candidate is back to
 * owing money against a deadline that is still running, which is precisely why the rejection copy
 * tells them to resubmit before it.
 */
export const isExpirySuspendedByPendingProof = async (
  paymentId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [pending] = await db
    .select({ id: financeManualPaymentProofs.id })
    .from(financeManualPaymentProofs)
    .where(
      and(
        eq(financeManualPaymentProofs.paymentId, paymentId),
        eq(financeManualPaymentProofs.status, "pending_review"),
      ),
    )
    .limit(1);

  return pending !== undefined;
};

export type ExpiredPaymentOutcome = {
  paymentId: string;
  registrationsCancelled: number;
};

export type PaymentExpirySweepResult = {
  examined: number;
  expired: ExpiredPaymentOutcome[];
  /** Payments that were overdue at selection but were no longer expirable once locked. */
  skipped: number;
};

/**
 * The overdue payments worth LOOKING at.
 *
 * Deliberately a cheap, slightly over-inclusive shortlist rather than the authoritative answer.
 * Everything selected here is re-checked under a lock before anything is written, because between
 * this query and that write a candidate can upload a proof and an organiser can verify one. A
 * selection query that tried to be authoritative would still be racing; it would just hide it.
 */
const selectOverduePayments = async (now: Date, db: Database): Promise<string[]> => {
  const rows = await db
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(
      and(
        eq(financePayments.origin, "manual_transfer"),
        // A zero-gross row is a free registration that happens to have been recorded. Nothing is
        // owed, so nothing can lapse.
        gt(financePayments.grossAmount, 0),
        lt(financePayments.dueAt, now),
      ),
    );

  return rows.map((row) => row.id);
};

/** Every registration sharing this payment's group — the team's rows, or the single payer's. */
const resolveGroupRegistrationIds = async (
  anchorRegistrationId: string,
  db: Database,
): Promise<string[]> => {
  const [anchor] = await db
    .select({ id: competitionRegistrations.id, teamId: competitionRegistrations.teamId })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, anchorRegistrationId))
    .limit(1);

  if (!anchor) return [];
  if (anchor.teamId === null) return [anchor.id];

  const rows = await db
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, anchor.teamId));

  return rows.map((row) => row.id);
};

/**
 * Expires ONE overdue payment, or declines to and says why.
 *
 * THE SERIALIZATION POINT IS THE ANCHOR REGISTRATION ROW, taken `FOR UPDATE` as the first statement
 * and held for the whole transaction. Everything after it — the pending-proof re-check, the
 * succeeded re-check, the event, the cancellations — happens with that row locked.
 *
 * This is what makes the boundary safe, and the ordering inside is not decorative. `submitManual
 * PaymentProof` takes the SAME lock before inserting, so the two paths cannot interleave:
 *
 *   worker first    — it holds the lock, cancels the registration, commits; the candidate's
 *                     submission then finds a cancelled registration and is refused.
 *   candidate first — the worker blocks on the lock, and when it acquires it re-reads the proof
 *                     table and finds the new `pending_review` row, so it declines to expire.
 *
 * EVERY DECLINE HERE RETURNS, AND A RETURN COMMITS. The checks below are not protected by the
 * surrounding transaction the way a throw would be — `return null` ends the callback normally, so
 * the transaction commits whatever was written before it. Each of them must therefore stay ABOVE
 * the cancellation write. Moved below it, a decline still reports "skipped" to the sweep while the
 * registration it declined to expire is already cancelled and committed.
 *
 * RELYING ON THE FOLD'S SUPPRESSION INSTEAD WOULD NOT BE ENOUGH, and that is the trap this design
 * exists to avoid. The fold does refuse to let a later `expired` override an earlier `succeeded`,
 * so the payment's STATUS would survive a badly-timed sweep. But the registration cancellation is
 * a separate write that the fold has no opinion about — a candidate whose payment was verified
 * one instant before the sweep would keep a `succeeded` payment and lose their registration.
 * Suppression protects the ledger's answer, not the candidate.
 */
const expireOnePayment = async (
  paymentId: string,
  now: Date,
  db: Database,
): Promise<ExpiredPaymentOutcome | null> => {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;

    const [payment] = await scoped
      .select({
        id: financePayments.id,
        registrationId: financePayments.competitionRegistrationId,
      })
      .from(financePayments)
      .where(eq(financePayments.id, paymentId))
      .limit(1);

    if (!payment?.registrationId) return null;

    // THE LOCK. Taken before any decision is read, so every check below observes state that cannot
    // move until this transaction ends.
    const locked = await scoped.execute(
      sql`select id from competition_registrations where id = ${payment.registrationId} for update`,
    );

    if ([...locked].length === 0) return null;

    // A proof awaiting review suspends expiry, however long the organiser takes. Re-read under the
    // lock rather than trusted from the selection query, and through the shared predicate so the
    // candidate's own view of the deadline cannot disagree with this decision.
    if (await isExpirySuspendedByPendingProof(payment.id, scoped)) return null;

    // Already paid. Re-read and re-folded under the lock, because a verification that committed
    // between selection and here is exactly the race this whole function is shaped around.
    const events = await scoped
      .select()
      .from(financePaymentEvents)
      .where(eq(financePaymentEvents.paymentId, payment.id));

    const state = foldPaymentEvents(events);

    if (state.status === "succeeded" || state.status === "refunded") return null;
    if (state.status === "expired") return null;

    await appendPaymentEvent(
      // Nobody decided this. The deadline passing is not an act by a person, and attributing it to
      // one would put a name on a cancellation they did not make.
      { type: "system" },
      {
        paymentId: payment.id,
        eventType: "expired",
        occurredAt: now,
        idempotencyKey: mintManualExpiryEventKey({ paymentId: payment.id }),
      },
      scoped,
    );

    // The whole payment group goes, not just the anchor. A team pays once, so a lapsed team payment
    // ends every member's registration — leaving three members "registered" for a competition their
    // team never paid for would be worse than cancelling them.
    const groupIds = await resolveGroupRegistrationIds(payment.registrationId, scoped);

    const cancelled = await scoped
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancellationReason: PAYMENT_EXPIRY_CANCELLATION_REASON,
        updatedAt: now,
      })
      // CAS on each row's status: a registration already cancelled by any other path is left
      // exactly as it is, with its own reason intact.
      .where(
        and(
          inArray(competitionRegistrations.id, groupIds),
          eq(competitionRegistrations.status, "confirmed"),
        ),
      )
      .returning({ id: competitionRegistrations.id });

    return { paymentId: payment.id, registrationsCancelled: cancelled.length };
  });
};

/**
 * Sweeps every overdue payment.
 *
 * Per-payment transactions rather than one transaction over the batch, deliberately: a single
 * payment that cannot be expired must not roll back the ones already handled, and holding a row
 * lock on every overdue registration at once would block every candidate mid-submission for the
 * length of the sweep.
 *
 * A failure on one payment is logged and the sweep continues, for the same reason. The next run
 * picks it up — the deadline does not move, so an overdue payment stays selectable until it is
 * either expired or paid.
 */
export const sweepExpiredPayments = async (
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<PaymentExpirySweepResult> => {
  const candidates = await selectOverduePayments(now, db);
  const expired: ExpiredPaymentOutcome[] = [];
  let skipped = 0;

  for (const paymentId of candidates) {
    try {
      const outcome = await expireOnePayment(paymentId, now, db);

      if (outcome) {
        expired.push(outcome);
        // Dispatched per payment, after that payment's own transaction has committed, so a
        // notification is only ever sent for a cancellation that survived. The helper swallows its
        // own failures: a lapsed registration that went unannounced is recoverable, a sweep that
        // aborts halfway because the queue is down is not.
        await notifyPaymentOutcome(outcome.paymentId, "expired", {}, db);
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      logger.warn("payment.expiry.payment_failed", {
        paymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("payment.expiry.sweep_completed", {
    examined: candidates.length,
    expired: expired.length,
    skipped,
  });

  return { examined: candidates.length, expired, skipped };
};
