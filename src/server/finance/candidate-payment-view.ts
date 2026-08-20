import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/candidate-payment-view");

import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePaymentInstructionSnapshots,
  financePayments,
} from "@/server/db/schema";
import { foldPaymentEvents, type PaymentDerivedStatus } from "@/lib/finance/payment-state";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import { isExpirySuspendedByPendingProof } from "@/server/finance/payment-expiry-service";

// WHAT A CANDIDATE IS TOLD ABOUT MONEY THEY OWE.
//
// One read, assembled from four tables, because the page is one page: how much, to which account,
// by when, and what became of the evidence they already sent. Splitting it into four calls at the
// page would let three of them succeed and one fail, and a payment page missing its account number
// is worse than a payment page that failed.
//
// EVERY MEMBER OF A TEAM SEES THIS. A team pays once, anchored on the captain's row (DEC-0168), so
// a member who asks about their own registration and is told "no payment" would conclude their team
// owes nothing. The group is resolved first and the view is returned to anyone in it.
//
// ONLY THE PAYER CAN ACT ON IT. `canSubmitProof` is computed here rather than at the page so the
// affordance can be WITHHELD rather than rendered and refused — the same posture DEC-0131 sets for
// the cancel control. A non-captain teammate sees what is owed and sees no upload control, which is
// the truth: `submitManualPaymentProof` filters on the payer and would refuse them.

export type CandidatePaymentInstructionsView = {
  bankName: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  qrisR2Key: string | null;
  instructionsNote: string | null;
};

export type CandidatePaymentProofView = {
  id: string;
  status: ManualPaymentProofStatus;
  submittedAt: Date;
  originalFileName: string;
  rejectionReason: string | null;
  resubmissionAllowed: boolean;
  resubmissionCount: number;
};

export type CandidatePaymentView = {
  paymentId: string;
  competitionId: string;
  currency: string;
  grossAmount: number;
  dueAt: Date | null;
  /**
   * Whether the deadline above is currently held open by a proof awaiting a verdict.
   *
   * Resolved through the SAME predicate the expiry worker consults before cancelling anything, so
   * the countdown this candidate sees and the decision the worker makes cannot disagree. The
   * deadline governs SUBMISSION, never the organiser's verdict — a candidate waiting on a slow
   * review is not at risk, and the surface must not imply they are.
   */
  deadlineSuspended: boolean;
  status: PaymentDerivedStatus;
  /**
   * Where to send the money, as it stood when the payment was created.
   *
   * From the SNAPSHOT, never from the institution's live row (DEC-0169's reasoning applied to the
   * account rather than the deadline). An organiser who changes bank accounts must not silently
   * repoint a payer who is mid-transfer at an account the payer never agreed to.
   *
   * Null only for a payment created before the snapshot existed; every priced manual payment
   * written from now on has one, because `createPayment` refuses without it.
   */
  instructions: CandidatePaymentInstructionsView | null;
  proof: CandidatePaymentProofView | null;
  isPayer: boolean;
  canSubmitProof: boolean;
  canResubmitProof: boolean;
};

/** The chargeable payment anchoring this registration's group, or null for a free competition. */
const loadGroupPayment = async (registrationId: string, db: Database) => {
  const [self] = await db
    .select({ id: competitionRegistrations.id, teamId: competitionRegistrations.teamId })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, registrationId))
    .limit(1);

  if (!self) return null;

  const groupIds =
    self.teamId === null
      ? [self.id]
      : (
          await db
            .select({ id: competitionRegistrations.id })
            .from(competitionRegistrations)
            .where(eq(competitionRegistrations.teamId, self.teamId))
        ).map((row) => row.id);

  const [payment] = await db
    .select()
    .from(financePayments)
    .where(
      and(
        inArray(financePayments.competitionRegistrationId, groupIds),
        // A zero-gross row is a free registration that happens to have been recorded. There is
        // nothing to pay and therefore nothing to show.
        gt(financePayments.grossAmount, 0),
      ),
    )
    .limit(1);

  return payment ? { payment, groupIds } : null;
};

/**
 * Everything the candidate's payment page renders, or null when there is nothing to pay.
 *
 * Null covers three different situations on purpose — no such registration, a registration in
 * someone else's payment group, and a free competition. A candidate probing registration ids learns
 * the same thing about all three, which is nothing.
 */
export const loadCandidatePaymentView = async (
  registrationId: string,
  userId: string,
  db: Database = getDb(),
): Promise<CandidatePaymentView | null> => {
  const group = await loadGroupPayment(registrationId, db);
  if (!group) return null;

  const { payment, groupIds } = group;

  // MEMBERSHIP IS THE ACCESS CHECK, and it is asked of the GROUP rather than of the registration
  // that was named. Scoping to `registrationId` alone would answer correctly for an individual and
  // wrongly for a team: a member could pass any teammate's registration id and be refused on their
  // own team's payment.
  const [membership] = await db
    .select({ id: competitionRegistrations.id, status: competitionRegistrations.status })
    .from(competitionRegistrations)
    .where(
      and(
        inArray(competitionRegistrations.id, groupIds),
        eq(competitionRegistrations.studentId, userId),
      ),
    )
    .limit(1);

  if (!membership) return null;

  const [snapshot] = await db
    .select()
    .from(financePaymentInstructionSnapshots)
    .where(eq(financePaymentInstructionSnapshots.paymentId, payment.id))
    .limit(1);

  const events = await db
    .select()
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, payment.id));

  const [proof] = await db
    .select()
    .from(financeManualPaymentProofs)
    .where(eq(financeManualPaymentProofs.paymentId, payment.id))
    .limit(1);

  const [anchor] = await db
    .select({ competitionId: competitionRegistrations.competitionId })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, payment.competitionRegistrationId ?? ""))
    .limit(1);

  const status = foldPaymentEvents(events).status;
  const isPayer = payment.payerUserId === userId;

  // A settled payment and a cancelled registration both close the lane. Neither is a refusal the
  // candidate has to discover by clicking — the control is simply not offered.
  const laneOpen =
    membership.status !== "cancelled" &&
    status !== "succeeded" &&
    status !== "refunded" &&
    status !== "expired";

  return {
    paymentId: payment.id,
    competitionId: anchor?.competitionId ?? "",
    currency: payment.currency,
    grossAmount: payment.grossAmount,
    dueAt: payment.dueAt,
    deadlineSuspended: await isExpirySuspendedByPendingProof(payment.id, db),
    status,
    instructions: snapshot
      ? {
          bankName: snapshot.bankName,
          accountNumber: snapshot.accountNumber,
          accountHolderName: snapshot.accountHolderName,
          qrisR2Key: snapshot.qrisR2Key,
          instructionsNote: snapshot.instructionsNote,
        }
      : null,
    proof: proof
      ? {
          id: proof.id,
          status: proof.status,
          submittedAt: proof.submittedAt,
          originalFileName: proof.originalFileName,
          rejectionReason: proof.rejectionReason,
          resubmissionAllowed: proof.resubmissionAllowed,
          resubmissionCount: proof.resubmissionCount,
        }
      : null,
    isPayer,
    canSubmitProof: isPayer && laneOpen && proof === undefined,
    // The two reopenable arms, restated from the CAS they must agree with: a rejection the organiser
    // left open, or a void. A void ignores the organiser's bar deliberately — it is platform_ops
    // correcting something the organiser's rejection was not about.
    canResubmitProof:
      isPayer &&
      laneOpen &&
      proof !== undefined &&
      ((proof.status === "rejected" && proof.resubmissionAllowed) || proof.status === "voided"),
  };
};
