import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/organiser-payment-review");

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  competitions,
  financeManualPaymentProofAttempts,
  financeManualPaymentProofs,
  financePayments,
  users,
} from "@/server/db/schema";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";

// THE ORGANISER'S REVIEW QUEUE, and the one place in this lane where a read crosses from an
// institution to a CANDIDATE'S rows.
//
// That direction is why the scope is in the WHERE rather than applied by the caller. Step
// 7.2-MANUAL.1's critical finding was on the verdict path, and MANUAL-D6 records why it was missed:
// a single-institution fixture cannot catch a missing scope, because every id it holds belongs to
// the same tenant and an unscoped query looks correct against all of them.
//
// The competition is joined and filtered on `institution_id` in the same statement that selects the
// proofs. A competition belonging to another organiser matches no row, so the queue is EMPTY rather
// than forbidden, and the caller learns nothing about whether that competition exists.

export type OrganiserProofRow = {
  proofId: string;
  paymentId: string;
  status: ManualPaymentProofStatus;
  submittedAt: Date;
  originalFileName: string;
  r2Key: string;
  fileSizeBytes: number;
  contentType: string;
  resubmissionCount: number;
  resubmissionAllowed: boolean;
  rejectionReason: string | null;
  reviewedAt: Date | null;
  /** What the payer owes, from the payment the proof is filed against, never re-derived. */
  grossAmount: number;
  currency: string;
  dueAt: Date | null;
  payer: {
    userId: string;
    /** Their profile name where they have one, falling back to the handle. Never the email. */
    displayName: string;
  };
  /** Closed attempts preceding the live one. Zero for a first submission. */
  priorAttempts: number;
};

/**
 * Every bukti transfer on one competition, newest first, for the institution that owns it.
 *
 * Returns an empty list, never throws, when the competition is not this institution's. A refusal
 * would confirm the competition exists; an empty queue is indistinguishable from a competition with
 * no proofs, which is what an organiser with no business here should observe.
 */
export const loadOrganiserPaymentQueue = async (
  institutionId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<OrganiserProofRow[]> => {
  const rows = await db
    .select({
      proofId: financeManualPaymentProofs.id,
      paymentId: financeManualPaymentProofs.paymentId,
      status: financeManualPaymentProofs.status,
      submittedAt: financeManualPaymentProofs.submittedAt,
      originalFileName: financeManualPaymentProofs.originalFileName,
      r2Key: financeManualPaymentProofs.r2Key,
      fileSizeBytes: financeManualPaymentProofs.fileSizeBytes,
      contentType: financeManualPaymentProofs.contentType,
      resubmissionCount: financeManualPaymentProofs.resubmissionCount,
      resubmissionAllowed: financeManualPaymentProofs.resubmissionAllowed,
      rejectionReason: financeManualPaymentProofs.rejectionReason,
      reviewedAt: financeManualPaymentProofs.reviewedAt,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      dueAt: financePayments.dueAt,
      payerUserId: financePayments.payerUserId,
      username: users.username,
      fullName: candidateProfiles.fullName,
    })
    .from(financeManualPaymentProofs)
    // THE TENANT SCOPE. Joined and filtered here rather than checked afterwards: a post-filter is a
    // filter someone can forget to apply at the next call site, and this query is the one that
    // reaches candidate rows.
    .innerJoin(
      competitions,
      and(
        eq(competitions.id, financeManualPaymentProofs.competitionId),
        eq(competitions.institutionId, institutionId),
      ),
    )
    .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    .where(eq(financeManualPaymentProofs.competitionId, competitionId))
    .orderBy(desc(financeManualPaymentProofs.submittedAt));

  if (rows.length === 0) return [];

  const attemptCounts = await countPriorAttempts(
    rows.map((row) => row.proofId),
    db,
  );

  return rows.map((row) => ({
    proofId: row.proofId,
    paymentId: row.paymentId,
    status: row.status,
    submittedAt: row.submittedAt,
    originalFileName: row.originalFileName,
    r2Key: row.r2Key,
    fileSizeBytes: row.fileSizeBytes,
    contentType: row.contentType,
    resubmissionCount: row.resubmissionCount,
    resubmissionAllowed: row.resubmissionAllowed,
    rejectionReason: row.rejectionReason,
    reviewedAt: row.reviewedAt,
    grossAmount: row.grossAmount,
    currency: row.currency,
    dueAt: row.dueAt,
    payer: {
      userId: row.payerUserId,
      // The email is deliberately absent from this shape. An organiser reviewing a transfer needs
      // to know whose it is, not how to contact them outside the platform.
      displayName: row.fullName ?? row.username,
    },
    priorAttempts: attemptCounts.get(row.proofId) ?? 0,
  }));
};

/**
 * How many attempts each proof closed BEFORE the one on screen.
 *
 * Surfaced because it changes what a reviewer is looking at: a third receipt for one payment is a
 * different situation from a first, and the live row alone cannot say so. `resubmission_count` is
 * the same number but reads as an implementation detail, while "2 percobaan sebelumnya" is the fact
 * the reviewer needs.
 *
 * BOUNDED BY `resubmission_count`, WHICH IS THE INDEX OF THE ATTEMPT ON SCREEN. Counting every
 * attempt row instead counted the card's own verdict the moment one was filed, so a first-ever
 * proof announced "1 bukti sebelumnya" as soon as it was rejected: right on a pending card, wrong
 * on every decided one, which is why it read as correct for as long as nobody looked at a card
 * after ruling on it.
 */
const countPriorAttempts = async (
  proofIds: string[],
  db: Database,
): Promise<Map<string, number>> => {
  const rows = await db
    .select({ proofId: financeManualPaymentProofAttempts.proofId })
    .from(financeManualPaymentProofAttempts)
    .innerJoin(
      financeManualPaymentProofs,
      eq(financeManualPaymentProofs.id, financeManualPaymentProofAttempts.proofId),
    )
    .where(
      and(
        inArray(financeManualPaymentProofAttempts.proofId, proofIds),
        lt(
          financeManualPaymentProofAttempts.attemptNumber,
          financeManualPaymentProofs.resubmissionCount,
        ),
      ),
    );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.proofId, (counts.get(row.proofId) ?? 0) + 1);
  }
  return counts;
};
