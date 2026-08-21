import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/ops-payment-review");

import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
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
import {
  IN_FLIGHT_PROOF_STATUSES,
  type ManualPaymentProofStatus,
} from "@/lib/finance/payment-model";

// WHAT THE ESCAPE HATCH CAN SEE.
//
// DEC-0132 blocks an organiser from unpublishing while money is in flight, and platform_ops
// cancellation is the only way out. A hatch nobody can find is not a hatch, so this read exists to
// put the blocked competitions in front of the operator rather than making them know an id.
//
// THE LIST IS BUILT FROM `IN_FLIGHT_PROOF_STATUSES`, the same exported constant
// `hasCompetitionPaymentInFlight` uses to raise the block. Re-deriving "in flight" here with a
// second status list is how a surface ends up showing a set that is narrower than the set it is
// supposed to unblock — and the competition missing from the list is precisely the one nobody can
// rescue. One fact, one place.
//
// Cross-tenant by design and NOT a leak: platform_ops is the one role whose whole job spans
// institutions, and every page under /admin is gated on it plus the operational MFA challenge.
//
// TWO LISTS, TWO DIFFERENT QUESTIONS. The blocked list answers "which competitions cannot be
// withdrawn"; `loadOpsBarredProofs` answers "which payers cannot move". They are read separately
// because a barred proof blocks nothing — it is decided — and folding it into the in-flight
// constant would change the unpublish guard while pretending to change a page.

export type OpsInFlightProof = {
  proofId: string;
  paymentId: string;
  status: ManualPaymentProofStatus;
  submittedAt: Date;
  /** The value `resubmission_count` holds now. Attempt 0 is the first submission. */
  attempt: number;
  grossAmount: number;
  currency: string;
  dueAt: Date | null;
  payerDisplayName: string;
  /**
   * Whether THIS proof can be voided.
   *
   * A verified proof cannot: the ledger already carries a `succeeded` event and reversing it is a
   * different action this surface does not own. Every other row in this list is pending, so the
   * flag is only ever false on the verified ones. Resolved here rather than in the component so the
   * control is WITHHELD on the rows that would be refused, instead of rendered and then refused.
   */
  voidable: boolean;
};

/** A payer the organiser barred, whom only a void can release. */
export type OpsBarredProof = {
  proofId: string;
  paymentId: string;
  submittedAt: Date;
  attempt: number;
  /** The organiser's stated reason for the refusal, shown so the operator rules on the same facts. */
  rejectionReason: string | null;
  grossAmount: number;
  currency: string;
  dueAt: Date | null;
  payerDisplayName: string;
  competitionTitle: string;
  institutionSlug: string;
};

export type OpsBlockedCompetition = {
  competitionId: string;
  title: string;
  slug: string;
  institutionId: string;
  institutionSlug: string;
  /** `published` competitions are cancellable; the hatch's CAS refuses anything else. */
  status: string;
  proofs: OpsInFlightProof[];
};

/**
 * Every competition currently held open by an in-flight bukti transfer, newest proof first.
 *
 * Grouped by competition because the surface's two actions live at different levels: voiding is per
 * proof, cancelling is per competition, and an operator deciding between them needs to see all the
 * outstanding transfers on one competition together — cancelling with three unresolved proofs is a
 * different decision from cancelling with one.
 */
export const loadOpsBlockedCompetitions = async (
  db: Database = getDb(),
): Promise<OpsBlockedCompetition[]> => {
  const rows = await db
    .select({
      proofId: financeManualPaymentProofs.id,
      paymentId: financeManualPaymentProofs.paymentId,
      status: financeManualPaymentProofs.status,
      submittedAt: financeManualPaymentProofs.submittedAt,
      attempt: financeManualPaymentProofs.resubmissionCount,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      dueAt: financePayments.dueAt,
      username: users.username,
      fullName: candidateProfiles.fullName,
      competitionId: competitions.id,
      title: competitions.title,
      slug: competitions.slug,
      competitionStatus: competitions.status,
      institutionId: institutions.id,
      institutionSlug: institutions.slug,
    })
    .from(financeManualPaymentProofs)
    .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
    .innerJoin(competitions, eq(competitions.id, financeManualPaymentProofs.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    .where(
      and(
        inArray(financeManualPaymentProofs.status, [...IN_FLIGHT_PROOF_STATUSES]),
        // The same `gross_amount > 0` the block carries. A zero-priced payment cannot strand
        // anybody, so it never raises the block and must not appear as though it had.
        gt(financePayments.grossAmount, 0),
      ),
    )
    .orderBy(desc(financeManualPaymentProofs.submittedAt));

  const byCompetition = new Map<string, OpsBlockedCompetition>();

  for (const row of rows) {
    let entry = byCompetition.get(row.competitionId);

    if (!entry) {
      entry = {
        competitionId: row.competitionId,
        title: row.title,
        slug: row.slug,
        institutionId: row.institutionId,
        institutionSlug: row.institutionSlug,
        status: row.competitionStatus,
        proofs: [],
      };
      byCompetition.set(row.competitionId, entry);
    }

    entry.proofs.push({
      proofId: row.proofId,
      paymentId: row.paymentId,
      status: row.status,
      submittedAt: row.submittedAt,
      attempt: row.attempt,
      grossAmount: row.grossAmount,
      currency: row.currency,
      dueAt: row.dueAt,
      // The email is deliberately absent, as it is on the organiser's queue: an operator ruling on
      // a transfer needs to know whose it is, not how to contact them outside the platform.
      payerDisplayName: row.fullName ?? row.username,
      voidable: row.status === "pending_review",
    });
  }

  return [...byCompetition.values()];
};

/**
 * Payers the organiser barred from trying again — the population the void's second arm exists for.
 *
 * A SEPARATE READ FROM THE BLOCKED LIST, on purpose. `IN_FLIGHT_PROOF_STATUSES` answers "what is
 * holding this competition open", and a barred proof holds nothing open: it is decided, the
 * organiser can unpublish freely, and widening that constant to include it would silently change
 * the DEC-0132 unpublish guard as a side effect of adding a list to a page.
 *
 * These two lists exist for opposite reasons. The first is a competition that cannot be withdrawn;
 * this one is a person who cannot move. Without it the operator's only route to a barred proof is
 * to know its id, which is the hatch-only-its-author-can-open problem this page was built to solve.
 *
 * Scoped to registrations that are still live. Once the sweep has cancelled the registration the
 * lane is shut, a resubmission would be refused anyway, and offering the void there would be a
 * control that resolves nothing.
 */
export const loadOpsBarredProofs = async (db: Database = getDb()): Promise<OpsBarredProof[]> => {
  const rows = await db
    .select({
      proofId: financeManualPaymentProofs.id,
      paymentId: financeManualPaymentProofs.paymentId,
      submittedAt: financeManualPaymentProofs.submittedAt,
      attempt: financeManualPaymentProofs.resubmissionCount,
      rejectionReason: financeManualPaymentProofs.rejectionReason,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      dueAt: financePayments.dueAt,
      username: users.username,
      fullName: candidateProfiles.fullName,
      competitionTitle: competitions.title,
      institutionSlug: institutions.slug,
    })
    .from(financeManualPaymentProofs)
    .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, financePayments.competitionRegistrationId),
    )
    .innerJoin(competitions, eq(competitions.id, financeManualPaymentProofs.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    .where(
      and(
        eq(financeManualPaymentProofs.status, "rejected"),
        eq(financeManualPaymentProofs.resubmissionAllowed, false),
        ne(competitionRegistrations.status, "cancelled"),
        gt(financePayments.grossAmount, 0),
      ),
    )
    .orderBy(desc(financeManualPaymentProofs.submittedAt));

  return rows.map((row) => ({
    proofId: row.proofId,
    paymentId: row.paymentId,
    submittedAt: row.submittedAt,
    attempt: row.attempt,
    rejectionReason: row.rejectionReason,
    grossAmount: row.grossAmount,
    currency: row.currency,
    dueAt: row.dueAt,
    payerDisplayName: row.fullName ?? row.username,
    competitionTitle: row.competitionTitle,
    institutionSlug: row.institutionSlug,
  }));
};
