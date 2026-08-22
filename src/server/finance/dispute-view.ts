import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/dispute-view");

import { asc, desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  competitionRegistrations,
  competitions,
  financeManualPaymentProofAttempts,
  financeManualPaymentProofs,
  financePaymentEvents,
  financePayments,
  institutions,
  platformOpsAuditLogs,
  users,
} from "@/server/db/schema";
import { foldPaymentEvents, type PaymentDerivedState } from "@/lib/finance/payment-state";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";

// WHAT finance_ops CAN SEE, AND WHY IT IS ONLY SEEING.
//
// DEC-0162: under the manual origin the money lands in the ORGANISER'S own bank account and never
// touches platform infrastructure, so finance_ops has no independent record that a transfer
// happened and no way to confirm one. Only the organiser can look at their own statement. This
// module therefore reads and never writes a verdict: there is no reject, no verify, no void here,
// and the surface withholds those controls entirely rather than rendering them refused.
//
// PLATFORM-SCOPED, NOT TENANT-SCOPED, and that inverts the usual test. Every other reader in this
// lane is confined to one institution and the negative to prove is "cannot see the neighbour's
// rows". finance_ops is a platform role handling disputes that arrive from any institution, so
// seeing across tenants is the REQUIREMENT. The boundary that exists here is a ROLE boundary: a
// recruiter, a candidate or an unauthenticated caller must reach none of it, and finance_ops must
// reach no verdict path. That is what the tests assert, not tenancy.

const FILE_ACCESSED_EVENT = "finance_ops_payment_proof_file_accessed";

export type DisputeAttempt = {
  attemptNumber: number;
  originalFileName: string;
  fileSizeBytes: number;
  submittedAt: Date;
  verdict: ManualPaymentProofStatus;
  verdictReason: string | null;
  reviewedAt: Date;
};

export type DisputePaymentSummary = {
  paymentId: string;
  proofId: string | null;
  payerDisplayName: string;
  competitionTitle: string;
  institutionSlug: string;
  grossAmount: number;
  currency: string;
  proofStatus: ManualPaymentProofStatus | null;
  submittedAt: Date | null;
  dueAt: Date | null;
};

export type DisputePaymentDetail = DisputePaymentSummary & {
  payerUserId: string;
  originalFileName: string | null;
  fileSizeBytes: number | null;
  /** The live row's own reason, the verdict currently standing. */
  rejectionReason: string | null;
  resubmissionAllowed: boolean;
  /** Every CLOSED attempt, oldest first. Migration 0059's table is the only record of these. */
  history: DisputeAttempt[];
};

/**
 * Every manual-lane payment that has ever carried a bukti transfer, newest submission first.
 *
 * Cross-institution ON PURPOSE (see the module note). A dispute arrives naming a person and a
 * competition, not an institution, so a tenant-scoped list would require the operator to already
 * know the answer to the question they are asking.
 */
export const loadDisputePayments = async (
  db: Database = getDb(),
): Promise<DisputePaymentSummary[]> => {
  const rows = await db
    .select({
      paymentId: financePayments.id,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      dueAt: financePayments.dueAt,
      proofId: financeManualPaymentProofs.id,
      proofStatus: financeManualPaymentProofs.status,
      submittedAt: financeManualPaymentProofs.submittedAt,
      username: users.username,
      fullName: candidateProfiles.fullName,
      competitionTitle: competitions.title,
      institutionSlug: institutions.slug,
    })
    .from(financeManualPaymentProofs)
    .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
    .innerJoin(competitions, eq(competitions.id, financeManualPaymentProofs.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    .orderBy(desc(financeManualPaymentProofs.submittedAt));

  return rows.map((row) => ({
    paymentId: row.paymentId,
    proofId: row.proofId,
    payerDisplayName: row.fullName ?? row.username,
    competitionTitle: row.competitionTitle,
    institutionSlug: row.institutionSlug,
    grossAmount: row.grossAmount,
    currency: row.currency,
    proofStatus: row.proofStatus,
    submittedAt: row.submittedAt,
    dueAt: row.dueAt,
  }));
};

/**
 * One payment, its live proof, and every closed attempt behind it.
 *
 * THE HISTORY IS THE POINT. A live proof row shows only the attempt currently standing: a
 * resubmission overwrites the file, the reason and the verdict in place. A dispute is almost always
 * ABOUT an earlier attempt, "they rejected my first receipt and I sent another", and
 * `finance_manual_payment_proof_attempts` is the only record of it. A view that showed the live row
 * alone would answer every dispute with the state after the disagreement.
 */
export const loadDisputePaymentDetail = async (
  paymentId: string,
  db: Database = getDb(),
): Promise<DisputePaymentDetail | null> => {
  const [row] = await db
    .select({
      paymentId: financePayments.id,
      payerUserId: financePayments.payerUserId,
      grossAmount: financePayments.grossAmount,
      currency: financePayments.currency,
      dueAt: financePayments.dueAt,
      proofId: financeManualPaymentProofs.id,
      proofStatus: financeManualPaymentProofs.status,
      submittedAt: financeManualPaymentProofs.submittedAt,
      originalFileName: financeManualPaymentProofs.originalFileName,
      fileSizeBytes: financeManualPaymentProofs.fileSizeBytes,
      rejectionReason: financeManualPaymentProofs.rejectionReason,
      resubmissionAllowed: financeManualPaymentProofs.resubmissionAllowed,
      username: users.username,
      fullName: candidateProfiles.fullName,
      competitionTitle: competitions.title,
      institutionSlug: institutions.slug,
    })
    .from(financePayments)
    .leftJoin(
      financeManualPaymentProofs,
      eq(financeManualPaymentProofs.paymentId, financePayments.id),
    )
    .innerJoin(users, eq(users.id, financePayments.payerUserId))
    .leftJoin(candidateProfiles, eq(candidateProfiles.userId, financePayments.payerUserId))
    // REACHED THROUGH THE PAYMENT'S REGISTRATION, not through the proof. Joining the competition
    // on `financeManualPaymentProofs.competitionId` made this an inner join on a LEFT-joined column:
    // with no proof row that column is null, the row is eliminated, and the whole query returns
    // nothing. A payment nobody ever submitted evidence for therefore 404'd, and "I paid, they say
    // they never received anything" is one of the commonest disputes there is, which is precisely
    // the case this read-only view exists to let finance look at.
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, financePayments.competitionRegistrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(eq(financePayments.id, paymentId))
    .limit(1);

  if (!row) return null;

  const history = row.proofId ? await loadAttemptHistory(row.proofId, db) : [];

  return {
    paymentId: row.paymentId,
    payerUserId: row.payerUserId,
    proofId: row.proofId,
    payerDisplayName: row.fullName ?? row.username,
    competitionTitle: row.competitionTitle,
    institutionSlug: row.institutionSlug,
    grossAmount: row.grossAmount,
    currency: row.currency,
    proofStatus: row.proofStatus,
    submittedAt: row.submittedAt,
    dueAt: row.dueAt,
    originalFileName: row.originalFileName,
    fileSizeBytes: row.fileSizeBytes,
    rejectionReason: row.rejectionReason,
    resubmissionAllowed: row.resubmissionAllowed ?? true,
    history,
  };
};

/** Closed attempts for one proof, OLDEST FIRST. A dispute is read forwards, as it happened. */
const loadAttemptHistory = async (proofId: string, db: Database): Promise<DisputeAttempt[]> => {
  const rows = await db
    .select({
      attemptNumber: financeManualPaymentProofAttempts.attemptNumber,
      originalFileName: financeManualPaymentProofAttempts.originalFileName,
      fileSizeBytes: financeManualPaymentProofAttempts.fileSizeBytes,
      submittedAt: financeManualPaymentProofAttempts.submittedAt,
      verdict: financeManualPaymentProofAttempts.verdict,
      verdictReason: financeManualPaymentProofAttempts.verdictReason,
      reviewedAt: financeManualPaymentProofAttempts.reviewedAt,
    })
    .from(financeManualPaymentProofAttempts)
    .where(eq(financeManualPaymentProofAttempts.proofId, proofId))
    .orderBy(asc(financeManualPaymentProofAttempts.attemptNumber));

  return rows;
};

/**
 * The folded ledger for one payment: what the append-only events actually say happened.
 *
 * FOLDED, never read from a column, because there is no column: DEC-0133 makes the event stream the
 * only record and `finance_payments` carries no status of its own. Folded on the DETAIL page only
 * and not per row of the list, since one fold per listed payment is a query per row for a figure
 * the list does not need. The proof's own status is what an operator scans by.
 */
export const loadDisputeLedgerState = async (
  paymentId: string,
  db: Database = getDb(),
): Promise<PaymentDerivedState> => {
  const events = await db
    .select()
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, paymentId))
    .orderBy(asc(financePaymentEvents.occurredAt));

  return foldPaymentEvents(events);
};

type AuditableProof = {
  id: string;
  paymentId: string;
  competitionId: string;
  attempt: number;
  payerUserId: string;
  receivingInstitutionId: string;
};

/**
 * Records that finance_ops looked at somebody's receipt.
 *
 * Separate from the URL minting so it can be measured on its own: object storage is not configured
 * in the test environment, and an assertion about this row folded into the presigning path would
 * only ever run the branch where storage is DOWN, reporting the audit trail as proven while every
 * assertion about its shape sat unexecuted.
 *
 * Called BETWEEN the availability check and the presigner, and both sides of that matter. Below the
 * check, because with storage down no file is read and a row would record an access that never
 * happened. Above the presigner, because a URL minted first is a read that could escape the log.
 */
export const recordDisputeProofAccess = async (
  actorUserId: string,
  proof: AuditableProof,
  db: Database = getDb(),
): Promise<void> => {
  await db.insert(platformOpsAuditLogs).values({
    actorUserId,
    // The PAYER is the primary target. It is their bank details on the receipt, and "who looked at
    // this person's evidence" is the question this row has to answer.
    targetUserId: proof.payerUserId,
    // AND THE TENANT, because the other question the row has to answer is the institution's:
    // "which of our candidates' receipts has platform staff opened". That query is what
    // `target_institution_id` is indexed for, and leaving it null returned nothing for every
    // finance read. The competition id was recorded, but only inside unindexed metadata.
    targetInstitutionId: proof.receivingInstitutionId,
    eventType: FILE_ACCESSED_EVENT,
    reason: "Penanganan sengketa pembayaran",
    metadata: {
      proofId: proof.id,
      paymentId: proof.paymentId,
      competitionId: proof.competitionId,
      attempt: proof.attempt,
    },
  });
};

/**
 * A short-lived link to the receipt itself, for finance_ops.
 *
 * A SEPARATE PATH FROM THE ORGANISER'S, and separate for one reason: the audit row. The organiser's
 * read is scoped to their institution and recorded against it, because an institution disputing
 * what its own staff saw needs that record. A finance_ops read crosses every tenant and is recorded
 * against the PAYER, in the platform operator log, under its own event type. Reusing the
 * organiser's function would file a platform read under an institution's own trail and make the two
 * indistinguishable afterwards, which is the question an access dispute exists to answer.
 *
 * Reading is all it does. There is no finance_ops path in this module that writes a verdict.
 */
export const generateDisputeProofViewUrl = async (
  actorUserId: string,
  proofId: string,
  db: Database = getDb(),
): Promise<{ url: string; contentType: string }> => {
  const [proof] = await db
    .select({
      id: financeManualPaymentProofs.id,
      paymentId: financeManualPaymentProofs.paymentId,
      competitionId: financeManualPaymentProofs.competitionId,
      r2Key: financeManualPaymentProofs.r2Key,
      contentType: financeManualPaymentProofs.contentType,
      attempt: financeManualPaymentProofs.resubmissionCount,
      payerUserId: financePayments.payerUserId,
      receivingInstitutionId: financePayments.receivingInstitutionId,
    })
    .from(financeManualPaymentProofs)
    .innerJoin(financePayments, eq(financePayments.id, financeManualPaymentProofs.paymentId))
    .where(eq(financeManualPaymentProofs.id, proofId))
    .limit(1);

  if (!proof) {
    throw new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404);
  }

  if (!isR2Available()) {
    throw new ManualProofError(
      "manual_proof_upload_unavailable",
      "Penyimpanan berkas belum dikonfigurasi sehingga bukti transfer tidak dapat dibuka",
      503,
    );
  }

  await recordDisputeProofAccess(actorUserId, proof, db);

  const url = await generatePresignedGetUrl(proof.r2Key, 120, {
    responseContentType: proof.contentType,
    responseContentDisposition: "inline",
  });

  return { url, contentType: proof.contentType };
};

export { FILE_ACCESSED_EVENT };
