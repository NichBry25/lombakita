import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/paid-registration");

import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePayments,
} from "@/server/db/schema";
import { IN_FLIGHT_PROOF_STATUSES } from "@/lib/finance/payment-model";
import { foldPaymentEvents } from "@/lib/finance/payment-state";

// THE TWO PAID PREDICATES. They are different questions with different answers, and they are kept
// apart here for the same reason DEC-0131 and DEC-0132 are kept apart:
//
//   CONFIRMED PAID     — money is known to have arrived. Drives DEC-0131 (non-refundable on
//                        candidate initiative). Answering yes commits the platform to the position
//                        that a candidate has parted with money.
//   PAYMENT IN FLIGHT  — someone has claimed to have sent money and nobody has said otherwise.
//                        Drives DEC-0132 (unpublish blocked). Fires EARLIER than confirmed-paid, on
//                        purpose: the window where a candidate has transferred real rupiah but the
//                        organiser has not verified it yet is exactly the window in which
//                        unpublishing would strand them.
//
// Collapsing them into one "is this paid" helper would pick one of those two moments and get the
// other wrong. In flight but not confirmed is the common case, not an edge case.
//
// ROW EXISTENCE IS NOT THE PREDICATE. Step 7.1 accepts `gross_amount = 0`, so a FREE registration
// can legitimately carry a payment row, and there is no status column to read — state is FOLDED
// from the event stream (DEC-0133). "A finance_payments row exists" is therefore true of free
// competitions and of failed attempts alike, and any predicate written that way reports paid for
// both.

/**
 * Every registration row that shares this one's payment: the rows sharing its `team_id`, or the row
 * itself when `team_id` is null.
 *
 * A team registration is ONE ROW PER MEMBER (submitTeamRegistration maps memberUserIds into N
 * inserts) but a team PAYS ONCE, anchored on the captain's row. So "has this person paid" cannot be
 * asked of their own row alone — three of the four members would answer no about a competition
 * their team has fully paid for.
 *
 * The branch here is on `team_id` being null, which is the definition of the group restated. It is
 * deliberately NOT a branch on `registration_type`: that column is a second copy of the same fact
 * (a CHECK keeps the two in agreement), and reading the copy is how one mode ends up with a code
 * path the other never exercises.
 */
export const resolvePaymentGroupRegistrationIds = async (
  registrationId: string,
  db: Database = getDb(),
): Promise<string[]> => {
  const [self] = await db
    .select({ id: competitionRegistrations.id, teamId: competitionRegistrations.teamId })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, registrationId))
    .limit(1);

  if (!self) return [];
  if (self.teamId === null) return [self.id];

  const rows = await db
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, self.teamId));

  return rows.map((row) => row.id);
};

/** The priced payments anchored anywhere on this registration's payment group. */
const loadChargeablePaymentIds = async (
  registrationId: string,
  db: Database,
): Promise<string[]> => {
  const groupIds = await resolvePaymentGroupRegistrationIds(registrationId, db);
  if (groupIds.length === 0) return [];

  const rows = await db
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(
      and(
        inArray(financePayments.competitionRegistrationId, groupIds),
        // The whole reason row existence is not the predicate: a zero-gross row is a free
        // registration that happens to have been recorded, not a payment.
        gt(financePayments.grossAmount, 0),
      ),
    );

  return rows.map((row) => row.id);
};

/**
 * CONFIRMED PAID — a priced payment on this registration's payment group has FOLDED to `succeeded`.
 *
 * The fold is what makes this trustworthy: a payment with an `initiated` event and a later `failed`
 * one has rows in the ledger and has not been paid, and a payment that succeeded and was then
 * refunded folds to `refunded` rather than `succeeded`. Reading a status column would answer all
 * three the same way, which is why there is no status column to read.
 */
export const isRegistrationConfirmedPaid = async (
  registrationId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const paymentIds = await loadChargeablePaymentIds(registrationId, db);
  if (paymentIds.length === 0) return false;

  const events = await db
    .select()
    .from(financePaymentEvents)
    .where(inArray(financePaymentEvents.paymentId, paymentIds));

  // Folded PER PAYMENT. Folding the union would let an `initiated` on one payment and a
  // `succeeded` on another combine into a success neither of them had.
  for (const paymentId of paymentIds) {
    const own = events.filter((event) => event.paymentId === paymentId);
    if (foldPaymentEvents(own).status === "succeeded") return true;
  }

  return false;
};

/**
 * PAYMENT IN FLIGHT — a bukti transfer has been submitted on this registration's payment group and
 * has not been rejected or voided.
 *
 * `verified` counts as in flight. It is not a contradiction: a verified proof means the organiser
 * accepted the transfer, which is the strongest possible reason not to unpublish out from under the
 * payer. The predicate this feeds asks "would withdrawing now strand someone who sent money",
 * and the answer for a verified proof is emphatically yes.
 */
export const isRegistrationPaymentInFlight = async (
  registrationId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const paymentIds = await loadChargeablePaymentIds(registrationId, db);
  if (paymentIds.length === 0) return false;

  const [row] = await db
    .select({ id: financeManualPaymentProofs.id })
    .from(financeManualPaymentProofs)
    .where(
      and(
        inArray(financeManualPaymentProofs.paymentId, paymentIds),
        inArray(financeManualPaymentProofs.status, [...IN_FLIGHT_PROOF_STATUSES]),
      ),
    )
    .limit(1);

  return row !== undefined;
};

/**
 * Whether ANY payment is in flight anywhere on this competition — the DEC-0132 unpublish question.
 *
 * Scoped by `competition_id` on the proof row rather than by walking registrations, so it is one
 * indexed read regardless of how many people have registered, and so a registration row cancelled
 * in the same transaction cannot make an outstanding proof invisible to the guard that runs before
 * it.
 */
export const hasCompetitionPaymentInFlight = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ id: financeManualPaymentProofs.id })
    .from(financeManualPaymentProofs)
    .where(
      and(
        eq(financeManualPaymentProofs.competitionId, competitionId),
        inArray(financeManualPaymentProofs.status, [...IN_FLIGHT_PROOF_STATUSES]),
      ),
    )
    .limit(1);

  return row !== undefined;
};
