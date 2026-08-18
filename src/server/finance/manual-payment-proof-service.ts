import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/manual-payment-proof-service");

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  financeManualPaymentProofs,
  financePayments,
  type FinanceManualPaymentProofRecord,
} from "@/server/db/schema";
import { appendPaymentEvent } from "@/server/finance/payment-service";
import { recordFeeAccrual, recordFeeAccrualReversal } from "@/server/finance/fee-accrual-service";
import { mintManualPaymentEventKey } from "@/server/finance/idempotency-key";

// THE BUKTI TRANSFER REVIEW LOOP. Services only — there is no upload route and no verification
// route yet; the surfaces that call these are not built.
//
// EVERY TRANSITION IS AN OPTIMISTIC CAS on the proof's status, and that is the concurrency guard the
// whole manual lane rests on (Rule 25: CAS for a single-row transition). It is NOT the idempotency
// key. The key cannot serve here: `appendPaymentEvent`'s platform arm mints a fresh UUID per call by
// design, so two organisers clicking "verify" at once would write two `succeeded` events — which the
// fold tolerates — and two fee accruals, which is money billed twice. The CAS means exactly one of
// those calls transitions the row and therefore exactly one reaches the accrual write.
//
// EVERY FUNCTION HERE IS SCOPED IN ITS OWN QUERY, and the scope sits in the same WHERE as the CAS
// rather than in a check the caller is trusted to have run first. Two scopes, because there are two
// kinds of actor:
//
//   ORGANISER SIDE  (verify / reject / read) — scoped to the institution that owns the proof's
//                   competition. A proof id from another organiser's competition matches no row and
//                   is indistinguishable from one that does not exist.
//   CANDIDATE SIDE  (submit / reopen)        — scoped to the person whose money it is. A payer may
//                   only file and refile evidence against their own payment.
//
// `voidManualPaymentProof` is deliberately unscoped: it is platform_ops-only, and operating across
// every tenant is what that role is for. Its authorization lives at its route.

export type ManualProofErrorCode =
  | "manual_proof_payment_not_found"
  | "manual_proof_not_found"
  | "manual_proof_not_manual_lane"
  | "manual_proof_already_submitted"
  | "manual_proof_not_pending"
  | "manual_proof_resubmission_barred"
  | "manual_proof_not_rejected"
  | "manual_proof_reason_required"
  | "manual_proof_object_key_invalid"
  | "manual_proof_concurrently_modified";

export class ManualProofError extends Error {
  constructor(
    public readonly code: ManualProofErrorCode,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
    this.name = "ManualProofError";
  }
}

/**
 * Where one payment's bukti transfer lives in object storage.
 *
 * THE COMPETITION SEGMENT LEADS, matching `buildRequestObjectPrefix`, and for the first of its two
 * reasons only: an ownership boundary a key can be checked against before anything touches storage.
 *
 * The second reason does NOT carry over, and the difference matters. For registration documents the
 * competition prefix exists so retention can delete the whole subtree once the competition is over.
 * A BUKTI TRANSFER IS NEVER PURGED, AT ANY AGE — it is financial evidence, and the competition
 * ending is not a reason to destroy the record of who paid for it. Nothing may ever list this prefix
 * for deletion; see finance-retention-exclusion.test.ts, which fails if the retention sweep's purge
 * surface grows a path to it.
 */
export const buildManualProofObjectPrefix = (competitionId: string, paymentId: string): string =>
  `payment-proofs/${competitionId}/${paymentId}/`;

/**
 * Refuses an object key that is not this payment's own.
 *
 * THE ONE PLACE THE PREFIX IS ENFORCED, called by every path that writes `r2_key`. Checking it at
 * one of two write paths is what makes the prefix a naming convention rather than a boundary: a
 * proof row could then point at any object in the bucket, including another payer's receipt, which
 * the row would go on to present as its own evidence.
 *
 * Three rules, and the second is the one that is easy to argue away:
 *
 *   1. The key sits under this competition and payment's prefix. The trailing slash is doing real
 *      work — without it a competition whose id is a string prefix of another's would match.
 *   2. No path segment is `..`. Object keys are literal strings in R2 and `..` resolves to nothing
 *      there, so this is not exploitable against today's storage. It is refused anyway because that
 *      is a property of the CURRENT STORAGE LAYER rather than of the key, and keys travel — a local
 *      cache, a presigner that canonicalises, or a CDN that collapses segments each turn the same
 *      string into a traversal.
 *   3. Something follows the prefix. A key equal to the prefix names a folder, not evidence.
 */
const assertObjectKeyBelongsToPayment = (
  r2Key: string,
  competitionId: string,
  paymentId: string,
): void => {
  const prefix = buildManualProofObjectPrefix(competitionId, paymentId);
  const hasTraversalSegment = r2Key.split("/").includes("..");

  if (!r2Key.startsWith(prefix) || r2Key.length === prefix.length || hasTraversalSegment) {
    throw new ManualProofError(
      "manual_proof_object_key_invalid",
      "The uploaded file is not stored under this payment's own prefix",
    );
  }
};

/**
 * The competition ids one institution owns, as a subquery.
 *
 * Returned as a subquery rather than a resolved array so the scope composes into the SAME statement
 * as the CAS it guards. Resolving it first and comparing in application code reintroduces the gap
 * the scope exists to close: between the two round trips the row can move.
 */
const competitionIdsOwnedBy = (institutionId: string, db: Database) =>
  db
    .select({ id: competitions.id })
    .from(competitions)
    .where(eq(competitions.institutionId, institutionId));

export type SubmitManualProofInput = {
  paymentId: string;
  submittedByUserId: string;
  r2Key: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

/**
 * Records a candidate's first bukti transfer for a payment.
 *
 * One proof per payment, enforced by a unique index. A second submission is a RESUBMISSION and goes
 * through `reopenManualPaymentProof`, which is the only path that respects the organiser's
 * resubmission bar — inserting a fresh row here instead would walk straight around it.
 *
 * The payment lookup is filtered on the PAYER, so a candidate can only file evidence against their
 * own payment. Someone else's payment id reads as no payment at all.
 *
 * The object key is held to this payment's own prefix BEFORE the insert, the same rule a
 * resubmission is held to. A first submission is the more common path, so checking only the
 * resubmission would leave the boundary open on the side that carries most of the traffic.
 */
export const submitManualPaymentProof = async (
  input: SubmitManualProofInput,
  db: Database = getDb(),
): Promise<FinanceManualPaymentProofRecord> => {
  const [payment] = await db
    .select({
      id: financePayments.id,
      origin: financePayments.origin,
      registrationId: financePayments.competitionRegistrationId,
    })
    .from(financePayments)
    .where(
      and(
        eq(financePayments.id, input.paymentId),
        eq(financePayments.payerUserId, input.submittedByUserId),
      ),
    )
    .limit(1);

  if (!payment) {
    throw new ManualProofError("manual_proof_payment_not_found", "Payment not found", 404);
  }

  if (payment.origin !== "manual_transfer") {
    throw new ManualProofError(
      "manual_proof_not_manual_lane",
      "Only a manual-transfer payment takes a bukti transfer",
    );
  }

  const competitionId = await loadCompetitionIdForPayment(payment.id, db);

  assertObjectKeyBelongsToPayment(input.r2Key, competitionId, payment.id);

  const [created] = await db
    .insert(financeManualPaymentProofs)
    .values({
      paymentId: payment.id,
      competitionId,
      submittedByUserId: input.submittedByUserId,
      status: "pending_review",
      r2Key: input.r2Key,
      originalFileName: input.originalFileName,
      fileSizeBytes: input.fileSizeBytes,
      contentType: input.contentType,
    })
    .onConflictDoNothing({ target: financeManualPaymentProofs.paymentId })
    .returning();

  if (!created) {
    throw new ManualProofError(
      "manual_proof_already_submitted",
      "This payment already has a bukti transfer — resubmit through the revision loop instead",
      409,
    );
  }

  return created;
};

/**
 * The competition a payment's proof belongs to, resolved through the registration it anchors on.
 *
 * Denormalised onto the proof row at insert so every organiser-side read can scope in the query.
 * Deriving it here rather than trusting a caller-supplied competition id is what stops a proof
 * being filed against a competition its payment has nothing to do with.
 */
const loadCompetitionIdForPayment = async (paymentId: string, db: Database): Promise<string> => {
  const [row] = await db
    .select({ competitionId: competitionRegistrations.competitionId })
    .from(financePayments)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, financePayments.competitionRegistrationId),
    )
    .where(eq(financePayments.id, paymentId))
    .limit(1);

  if (!row) {
    throw new ManualProofError(
      "manual_proof_payment_not_found",
      "Payment has no competition registration to scope its proof to",
      404,
    );
  }

  return row.competitionId;
};

/**
 * Accepts a bukti transfer: the money is confirmed received.
 *
 * Three writes, one transaction, in an order that is not arbitrary:
 *
 *   1. CAS the proof `pending_review` → `verified`. Losing the CAS ends the call — this is what
 *      makes steps 2 and 3 single-shot.
 *   2. Append the `succeeded` event. The payment's state is FOLDED from events, so this is what
 *      actually makes it paid.
 *   3. Record the fee accrual. Last because it is the only step whose duplicate costs money, so it
 *      sits behind both the CAS and the partial unique index.
 */
export const verifyManualPaymentProof = async (
  institutionId: string,
  reviewerUserId: string,
  proofId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  return db.transaction(async (tx) => {
    const [proof] = await tx
      .update(financeManualPaymentProofs)
      .set({
        status: "verified",
        reviewerUserId,
        reviewedAt: now,
        updatedAt: now,
      })
      // The CAS. `status = 'pending_review'` in the WHERE is the whole guard: a concurrent verify
      // that already moved the row matches nothing and returns no row. The tenant scope rides in the
      // same WHERE, so accepting another organiser's transfer — and accruing a fee against their
      // institution — matches nothing either.
      .where(
        and(
          eq(financeManualPaymentProofs.id, proofId),
          eq(financeManualPaymentProofs.status, "pending_review"),
          inArray(
            financeManualPaymentProofs.competitionId,
            competitionIdsOwnedBy(institutionId, tx as unknown as Database),
          ),
        ),
      )
      .returning();

    if (!proof) {
      throw new ManualProofError(
        "manual_proof_not_pending",
        "This bukti transfer is not awaiting review — it may have been reviewed already",
        409,
      );
    }

    const [payment] = await tx
      .select({
        id: financePayments.id,
        grossAmount: financePayments.grossAmount,
        currency: financePayments.currency,
      })
      .from(financePayments)
      .where(eq(financePayments.id, proof.paymentId))
      .limit(1);

    if (!payment) {
      throw new ManualProofError("manual_proof_payment_not_found", "Payment not found", 404);
    }

    await appendPaymentEvent(
      // A named human accepted this transfer, so the actor is that human. Positional by design —
      // see the type's docblock; it must never come from a request body.
      { type: "user", userId: reviewerUserId },
      {
        paymentId: payment.id,
        eventType: "succeeded",
        occurredAt: now,
        // Amount and currency travel together or not at all (a CHECK enforces the pairing).
        amount: payment.grossAmount,
        currency: payment.currency,
        idempotencyKey: mintManualPaymentEventKey({
          action: "succeeded",
          proofId: proof.id,
          attempt: proof.resubmissionCount,
        }),
      },
      tx,
    );

    await recordFeeAccrual(payment.id, tx);

    return proof;
  });
};

/**
 * Refuses a bukti transfer, keeping the reason on the row.
 *
 * `resubmissionAllowed` is the ORGANISER'S decision and is taken here rather than defaulted,
 * because barring resubmission is a real verdict ("this is not a transfer to us at all") and not
 * merely a UI state. The bar is enforced in `reopenManualPaymentProof`'s CAS — hiding a button
 * would leave the endpoint open.
 *
 * No finance event is written. A rejected proof means nothing has been established about the money
 * either way; recording a `failed` event would assert that the payment did not happen, which the
 * organiser has not said.
 */
export const rejectManualPaymentProof = async (
  institutionId: string,
  reviewerUserId: string,
  proofId: string,
  reason: string,
  resubmissionAllowed: boolean,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  if (reason.trim().length === 0) {
    throw new ManualProofError(
      "manual_proof_reason_required",
      "A rejection must state its reason so the candidate knows what to fix",
    );
  }

  const [proof] = await db
    .update(financeManualPaymentProofs)
    .set({
      status: "rejected",
      reviewerUserId,
      rejectionReason: reason.trim(),
      resubmissionAllowed,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(financeManualPaymentProofs.id, proofId),
        eq(financeManualPaymentProofs.status, "pending_review"),
        inArray(financeManualPaymentProofs.competitionId, competitionIdsOwnedBy(institutionId, db)),
      ),
    )
    .returning();

  if (!proof) {
    throw new ManualProofError(
      "manual_proof_not_pending",
      "This bukti transfer is not awaiting review — it may have been reviewed already",
      409,
    );
  }

  return proof;
};

export type ReopenManualProofInput = {
  proofId: string;
  // The payer refiling their own evidence. Scoped on in the query, never assumed by the caller.
  submittedByUserId: string;
  r2Key: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

/**
 * Reopens a rejected bukti transfer with a replacement file (DEC-0115 revision loop).
 *
 * `rejection_reason` is deliberately NOT cleared. The reviewer of attempt two needs to see what
 * attempt one was refused for, and clearing it would hand them a fresh-looking submission with no
 * indication it is a second try.
 *
 * THE RESUBMISSION BAR IS IN THIS CAS, not in a caller's if-statement and not in a hidden control:
 * `resubmission_allowed = true` sits in the WHERE alongside `status = 'rejected'`, so a barred proof
 * matches nothing no matter which surface calls this. `submitted_by_user_id` rides in the same
 * WHERE: only the payer refiles their own evidence.
 *
 * The replacement key goes through the same `assertObjectKeyBelongsToPayment` the first submission
 * does, so a resubmission cannot reach an object the original could not have.
 */
export const reopenManualPaymentProof = async (
  input: ReopenManualProofInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  const [existing] = await db
    .select({
      id: financeManualPaymentProofs.id,
      paymentId: financeManualPaymentProofs.paymentId,
      competitionId: financeManualPaymentProofs.competitionId,
    })
    .from(financeManualPaymentProofs)
    .where(
      and(
        eq(financeManualPaymentProofs.id, input.proofId),
        eq(financeManualPaymentProofs.submittedByUserId, input.submittedByUserId),
      ),
    )
    .limit(1);

  // One message for every cause, deliberately: a candidate learning which of "not yours", "already
  // reopened" and "barred from reopening" applies gains nothing they can act on, and the states are
  // adjacent enough that distinguishing them invites probing.
  if (!existing) {
    throw new ManualProofError(
      "manual_proof_resubmission_barred",
      "This bukti transfer cannot be resubmitted",
      409,
    );
  }

  assertObjectKeyBelongsToPayment(input.r2Key, existing.competitionId, existing.paymentId);

  const [proof] = await db
    .update(financeManualPaymentProofs)
    .set({
      status: "pending_review",
      r2Key: input.r2Key,
      originalFileName: input.originalFileName,
      fileSizeBytes: input.fileSizeBytes,
      contentType: input.contentType,
      resubmissionCount: sql`${financeManualPaymentProofs.resubmissionCount} + 1`,
      reviewerUserId: null,
      reviewedAt: null,
      submittedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(financeManualPaymentProofs.id, input.proofId),
        eq(financeManualPaymentProofs.submittedByUserId, input.submittedByUserId),
        eq(financeManualPaymentProofs.status, "rejected"),
        eq(financeManualPaymentProofs.resubmissionAllowed, true),
      ),
    )
    .returning();

  if (!proof) {
    throw new ManualProofError(
      "manual_proof_resubmission_barred",
      "This bukti transfer cannot be resubmitted",
      409,
    );
  }

  return proof;
};

/**
 * Closes out a pending bukti transfer without ruling on the money — the DEC-0132 escape hatch, for
 * `platform_ops` only.
 *
 * NO FINANCE EVENT IS WRITTEN, and that is the defining property. Nothing was confirmed received,
 * so there is nothing to record as having succeeded, failed or been refunded; writing any event
 * here would put a claim in an append-only ledger that no one is in a position to make. The proof
 * simply stops being in flight, which unblocks the DEC-0132 unpublish guard.
 *
 * `reason` is mandatory and the caller is responsible for the audit row — this function writes the
 * finance-domain state, the ops route writes `platform_ops_audit_logs`, matching how every other
 * operational action in this codebase splits those two jobs.
 */
export const voidManualPaymentProof = async (
  actorUserId: string,
  proofId: string,
  reason: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<FinanceManualPaymentProofRecord> => {
  if (reason.trim().length === 0) {
    throw new ManualProofError(
      "manual_proof_reason_required",
      "Voiding a bukti transfer must state its reason",
    );
  }

  const [proof] = await db
    .update(financeManualPaymentProofs)
    .set({
      status: "voided",
      reviewerUserId: actorUserId,
      rejectionReason: reason.trim(),
      reviewedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(financeManualPaymentProofs.id, proofId),
        eq(financeManualPaymentProofs.status, "pending_review"),
      ),
    )
    .returning();

  if (!proof) {
    throw new ManualProofError(
      "manual_proof_not_pending",
      "Only a bukti transfer still awaiting review can be voided",
      409,
    );
  }

  return proof;
};

/**
 * Reverses the fee accrued on a payment whose verification is being walked back.
 *
 * Separate from `voidManualPaymentProof` because the two answer different questions: voiding closes
 * a proof nobody ruled on, while this compensates a fee that was already charged on a proof someone
 * DID accept. Bundling them would mean voiding a never-verified proof tried to reverse an accrual
 * that was never written.
 */
export const reverseVerifiedPaymentFee = async (
  paymentId: string,
  reason: string,
  db: Database = getDb(),
): Promise<void> => {
  await recordFeeAccrualReversal(paymentId, reason, db);
};

/**
 * One bukti transfer, readable only by the institution whose competition it belongs to.
 *
 * A proof row carries the payer's `r2_key`, file name and rejection history, so an unscoped reader
 * over proof ids is a cross-tenant read waiting for its first caller. Another institution's proof is
 * indistinguishable from one that does not exist: null.
 */
export const loadManualPaymentProof = async (
  institutionId: string,
  proofId: string,
  db: Database = getDb(),
): Promise<FinanceManualPaymentProofRecord | null> => {
  const [proof] = await db
    .select()
    .from(financeManualPaymentProofs)
    .where(
      and(
        eq(financeManualPaymentProofs.id, proofId),
        inArray(financeManualPaymentProofs.competitionId, competitionIdsOwnedBy(institutionId, db)),
      ),
    )
    .limit(1);

  return proof ?? null;
};

/**
 * Every bukti transfer on one competition, newest first.
 *
 * The competition scope is IN THE QUERY rather than applied by the caller afterwards, so a proof id
 * belonging to another organiser's competition collapses to "not in this list" instead of leaking.
 */
export const listManualPaymentProofsForCompetition = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<FinanceManualPaymentProofRecord[]> =>
  db
    .select()
    .from(financeManualPaymentProofs)
    .where(eq(financeManualPaymentProofs.competitionId, competitionId))
    .orderBy(sql`${financeManualPaymentProofs.submittedAt} DESC`);
