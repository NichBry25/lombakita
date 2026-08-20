import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/payment-notifications");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  competitionRegistrations,
  competitions,
  financeManualPaymentProofs,
  financePayments,
  institutions,
  users,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { enqueuePaymentOutcome, enqueuePaymentProofSubmitted } from "@/server/async/enqueue";

// EVERYTHING THE MANUAL LANE ANNOUNCES, assembled in one place.
//
// The three services that trigger these — submit, verdict, expiry — each hold a different slice of
// the facts a notification needs, and none holds all of them. Assembling the payload at each call
// site would mean three partial versions of the same query and three chances for one of them to
// name the competition differently from the others.
//
// DISPATCH NEVER FAILS THE WRITE. A payment that was verified and a notification that did not send
// is a recoverable state; a verification rolled back because Redis was down is not. Every helper
// here swallows its own failure into a log, matching how registration cancellation already
// enqueues.

type PaymentFacts = {
  registrationId: string;
  competitionTitle: string;
  competitionSlug: string;
  institutionId: string;
  institutionSlug: string;
  payerDisplayName: string;
  grossAmount: number;
  currency: string;
  /**
   * Which attempt the live proof is on, or 0 where no proof was ever filed (an expiry).
   *
   * Read here rather than passed in because the two verdict call sites hold a proof row and the
   * expiry sweep holds none, and an argument only two of three callers can supply is an argument
   * the third will guess at.
   */
  attempt: number;
};

/** One read for every fact a manual-lane notification needs, or null if the payment is unusable. */
const loadPaymentFacts = async (
  paymentId: string,
  db: Database,
): Promise<PaymentFacts | null> => {
  const [row] = await db
    .select({
      registrationId: financePayments.competitionRegistrationId,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      competitionTitle: competitions.title,
      competitionSlug: competitions.slug,
      institutionId: competitions.institutionId,
      institutionSlug: institutions.slug,
      username: users.username,
      fullName: candidateProfiles.fullName,
      attempt: financeManualPaymentProofs.resubmissionCount,
    })
    .from(financePayments)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, financePayments.competitionRegistrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    // LEFT, because a payment that expired with nothing submitted has no proof row at all.
    .leftJoin(
      financeManualPaymentProofs,
      eq(financeManualPaymentProofs.paymentId, financePayments.id),
    )
    .where(eq(financePayments.id, paymentId))
    .limit(1);

  if (!row?.registrationId) return null;

  return {
    registrationId: row.registrationId,
    competitionTitle: row.competitionTitle,
    competitionSlug: row.competitionSlug,
    institutionId: row.institutionId,
    institutionSlug: row.institutionSlug,
    // Their profile name where they have one, falling back to the handle. Never the email — an
    // organiser reviewing a transfer needs to know whose it is, not how to reach them off-platform.
    payerDisplayName: row.fullName ?? row.username,
    grossAmount: row.grossAmount,
    currency: row.currency,
    attempt: row.attempt ?? 0,
  };
};

const warnDispatchFailed = (event: string, paymentId: string, error: unknown): void => {
  logger.warn("notification.enqueue_failed", {
    event,
    paymentId,
    error: error instanceof Error ? error.message : String(error),
  });
};

/** Tells the organiser a bukti transfer is waiting. Organiser-only, per R13. */
export const notifyPaymentProofSubmitted = async (
  paymentId: string,
  proofId: string,
  attempt: number,
  db: Database = getDb(),
): Promise<void> => {
  try {
    const facts = await loadPaymentFacts(paymentId, db);
    if (!facts) return;

    await enqueuePaymentProofSubmitted({
      paymentId,
      proofId,
      // Taken from the caller's own returned row rather than re-read: the caller just wrote it, and
      // a second read could see a further resubmission and announce the wrong attempt.
      attempt,
      competitionTitle: facts.competitionTitle,
      institutionSlug: facts.institutionSlug,
      competitionSlug: facts.competitionSlug,
      institutionId: facts.institutionId,
      payerDisplayName: facts.payerDisplayName,
      grossAmount: facts.grossAmount,
      currency: facts.currency,
    });
  } catch (error) {
    warnDispatchFailed("payment.proof.submitted", paymentId, error);
  }
};

/**
 * Tells every member of the payment group what became of the money. Per R13, the whole group.
 *
 * `expired` carries no reason and no resubmission flag because there is no organiser decision to
 * describe — the copy downstream says so outright.
 */
export const notifyPaymentOutcome = async (
  paymentId: string,
  outcome: "verified" | "rejected" | "expired" | "voided",
  options: { rejectionReason?: string | null; resubmissionAllowed?: boolean | null } = {},
  db: Database = getDb(),
): Promise<void> => {
  try {
    const facts = await loadPaymentFacts(paymentId, db);
    if (!facts) return;

    await enqueuePaymentOutcome({
      paymentId,
      registrationId: facts.registrationId,
      attempt: facts.attempt,
      competitionTitle: facts.competitionTitle,
      outcome,
      // A void carries a reason like a rejection does, but never a bar: `reopenManualPaymentProof`
      // lets the voided arm through regardless of the organiser's earlier setting (R9/R20), so
      // sending a bar here would print a restriction the write path does not apply.
      rejectionReason:
        outcome === "rejected" || outcome === "voided" ? (options.rejectionReason ?? null) : null,
      resubmissionAllowed: outcome === "rejected" ? (options.resubmissionAllowed ?? null) : null,
      grossAmount: facts.grossAmount,
      currency: facts.currency,
    });
  } catch (error) {
    warnDispatchFailed("payment.outcome", paymentId, error);
  }
};
