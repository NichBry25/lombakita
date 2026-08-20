import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/finance/manual-payment-proof-service");

import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  financeManualPaymentProofAttempts,
  financeManualPaymentProofs,
  financePayments,
  institutionAuditLogs,
  type FinanceManualPaymentProofRecord,
} from "@/server/db/schema";
import { appendPaymentEvent } from "@/server/finance/payment-service";
import { recordFeeAccrual, recordFeeAccrualReversal } from "@/server/finance/fee-accrual-service";
import { mintManualPaymentEventKey } from "@/server/finance/idempotency-key";
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  isR2Available,
} from "@/server/storage/r2.client";
import {
  PAYMENT_PROOF_FORMAT_HINT,
  paymentProofMimeTypeForFileName,
} from "@/lib/finance/payment-proof-file";
import {
  notifyPaymentOutcome,
  notifyPaymentProofSubmitted,
} from "@/server/finance/payment-notifications";

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
  | "manual_proof_registration_cancelled"
  | "manual_proof_not_pending"
  | "manual_proof_resubmission_barred"
  | "manual_proof_not_rejected"
  | "manual_proof_reason_required"
  | "manual_proof_object_key_invalid"
  // The request named an action the verdict route does not implement. A malformed request, not a
  // judgement about the proof — which is why it does not borrow `manual_proof_not_pending`, a code
  // that asserts something specific and false about the row's state.
  | "manual_proof_action_unrecognised"
  | "manual_proof_upload_unavailable"
  // Not a refusal. Raised only by an internal invariant assertion; see `recordProofAttempt`.
  | "manual_proof_invariant_violation"
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
      "Berkas yang diunggah tidak tersimpan di lokasi bukti transfer pembayaran ini",
    );
  }
};

/** The three statuses an attempt can close in. `pending_review` is not one: it has not closed. */
type ProofVerdict = Extract<
  FinanceManualPaymentProofRecord["status"],
  "verified" | "rejected" | "voided"
>;

/**
 * Preserves a closing attempt in the append-only history, from the row the CAS just returned.
 *
 * WRITTEN AT CLOSE, NEVER AT SUBMISSION, and that is what keeps the history table append-only: a
 * row inserted when an attempt opened would have to be updated later to carry its verdict. So the
 * live proof row holds the OPEN attempt and this table holds every closed one; together they are
 * the whole history and nothing ever moves.
 *
 * Every value comes from the CAS's own `RETURNING` rather than a prior read. A second read could
 * observe a row that has since been reopened, and would then file attempt two's file under attempt
 * one's verdict — the exact confusion this table exists to prevent.
 *
 * Must be called inside the verdict's transaction. The unique index on (proof, attempt) is what
 * makes a replayed verdict a refusal rather than a duplicated history entry.
 */
const recordProofAttempt = async (
  tx: Database,
  proof: FinanceManualPaymentProofRecord,
  verdict: ProofVerdict,
  verdictReason: string | null,
): Promise<void> => {
  if (proof.reviewerUserId === null || proof.reviewedAt === null) {
    // INVARIANT ASSERTION, NOT A REFUSAL — and the three markers below are what say so, because a
    // reader who cannot tell those apart will translate this message on the next Indonesian sweep
    // and destroy the only signal it carries.
    //
    //   1. The `INVARIANT:` prefix. Deliberately English: this text is read in Sentry by a
    //      developer, never by a candidate, and an Indonesian sentence here would look like every
    //      other refusal in this file.
    //   2. Its OWN code. Reusing `manual_proof_not_pending` — which it did — made an alert on that
    //      code unable to separate "an organiser double-clicked verify" from "this row is corrupt".
    //   3. HTTP 500. No user action can produce this; it is unreachable through any verdict path,
    //      since each sets reviewer and reviewedAt in the same statement as the status.
    //
    // Asserted rather than coerced, so a future transition that forgets one fails here instead of
    // writing an attempt whose reviewer is unknown.
    throw new ManualProofError(
      "manual_proof_invariant_violation",
      "INVARIANT: a closed bukti transfer attempt must name its reviewer and the moment it was reviewed",
      500,
    );
  }

  await tx.insert(financeManualPaymentProofAttempts).values({
    proofId: proof.id,
    paymentId: proof.paymentId,
    competitionId: proof.competitionId,
    attemptNumber: proof.resubmissionCount,
    submittedByUserId: proof.submittedByUserId,
    r2Key: proof.r2Key,
    originalFileName: proof.originalFileName,
    fileSizeBytes: proof.fileSizeBytes,
    contentType: proof.contentType,
    submittedAt: proof.submittedAt,
    verdict,
    verdictReason,
    reviewerUserId: proof.reviewerUserId,
    reviewedAt: proof.reviewedAt,
  });
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

export type ManualProofUploadGrant = {
  uploadUrl: string;
  r2Key: string;
  contentType: string;
  expiresAt: Date;
};

const MANUAL_PROOF_UPLOAD_EXPIRY_SECONDS = 10 * 60;

// Short, because the URL is unauthenticated once minted: anyone holding it can read the receipt.
// Five minutes is long enough to open and read one and short enough that a URL pasted into a chat
// is dead before it travels.
const MANUAL_PROOF_VIEW_EXPIRY_SECONDS = 5 * 60;

/**
 * Presigns a PUT for one bukti transfer file.
 *
 * THE KEY IS BUILT HERE, NEVER ACCEPTED FROM THE CLIENT. `submitManualPaymentProof` and
 * `reopenManualPaymentProof` both hold whatever key they are handed to this payment's own prefix,
 * so a caller-supplied key can only ever be refused — but a presign that signed one would have
 * already granted write access to that object before the refusal. Deriving it from the payment the
 * payer actually owns is what makes the prefix rule a boundary rather than a late check.
 *
 * A fresh UUID per call, so a re-presign never overwrites the object a previous attempt uploaded.
 * The old object is orphaned rather than replaced; it is unreferenced by any row and is swept by
 * retention on the same prefix.
 *
 * The payment is looked up by PAYER, matching every other candidate-side function here: another
 * person's payment id reads as no payment at all rather than as a refusal that confirms it exists.
 */
export const generateManualProofUploadUrl = async (
  paymentId: string,
  payerUserId: string,
  input: { fileName: string },
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<ManualProofUploadGrant> => {
  const [payment] = await db
    .select({ id: financePayments.id, origin: financePayments.origin })
    .from(financePayments)
    .where(and(eq(financePayments.id, paymentId), eq(financePayments.payerUserId, payerUserId)))
    .limit(1);

  if (!payment) {
    throw new ManualProofError(
      "manual_proof_payment_not_found",
      "Pembayaran tidak ditemukan",
      404,
    );
  }

  if (payment.origin !== "manual_transfer") {
    throw new ManualProofError(
      "manual_proof_not_manual_lane",
      "Hanya pembayaran transfer manual yang menerima bukti transfer",
    );
  }

  const contentType = paymentProofMimeTypeForFileName(input.fileName);

  if (contentType === null) {
    throw new ManualProofError(
      "manual_proof_object_key_invalid",
      `Format tidak didukung. Unggah bukti transfer dalam format ${PAYMENT_PROOF_FORMAT_HINT}.`,
    );
  }

  if (!isR2Available()) {
    throw new ManualProofError(
      "manual_proof_upload_unavailable",
      "Penyimpanan berkas belum dikonfigurasi — unggahan sementara tidak tersedia",
      503,
    );
  }

  const competitionId = await loadCompetitionIdForPayment(payment.id, db);
  const r2Key = `${buildManualProofObjectPrefix(competitionId, payment.id)}${randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    r2Key,
    contentType,
    MANUAL_PROOF_UPLOAD_EXPIRY_SECONDS,
  );

  return {
    uploadUrl,
    r2Key,
    contentType,
    expiresAt: new Date(now.getTime() + MANUAL_PROOF_UPLOAD_EXPIRY_SECONDS * 1000),
  };
};

/**
 * A short-lived URL letting the reviewing organiser look at one bukti transfer.
 *
 * AUDITED, matching how every other organiser access to a candidate's uploaded file is treated
 * (`submission.file_accessed`, `document_request.file_accessed`). A transfer receipt carries the
 * payer's bank details and account name — reading it is an act on their data, and an institution
 * that later disputes what it saw needs a record that it looked.
 *
 * Scoped through `loadManualPaymentProof`, so a proof id from another organiser's competition
 * resolves to nothing and no URL is minted. The audit row is written only after that resolves,
 * because an audit entry for a read that was refused records an access that never happened.
 *
 * Rendered INLINE for the types this lane accepts. A receipt the reviewer has to download, open in
 * another application and match back to a row is a receipt that gets approved without being read.
 */
export const generateManualProofViewUrl = async (
  institutionId: string,
  actorUserId: string,
  proofId: string,
  db: Database = getDb(),
): Promise<{ url: string; contentType: string }> => {
  const proof = await loadManualPaymentProof(institutionId, proofId, db);

  if (!proof) {
    throw new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404);
  }

  if (!isR2Available()) {
    throw new ManualProofError(
      "manual_proof_upload_unavailable",
      "Penyimpanan berkas belum dikonfigurasi — bukti transfer tidak dapat dibuka",
      503,
    );
  }

  await db.insert(institutionAuditLogs).values({
    institutionId,
    actorUserId,
    action: "payment_proof.file_accessed",
    metadata: {
      proofId: proof.id,
      paymentId: proof.paymentId,
      competitionId: proof.competitionId,
      attempt: proof.resubmissionCount,
    },
  });

  const url = await generatePresignedGetUrl(proof.r2Key, MANUAL_PROOF_VIEW_EXPIRY_SECONDS, {
    responseContentType: proof.contentType,
    responseContentDisposition: "inline",
  });

  return { url, contentType: proof.contentType };
};

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
    throw new ManualProofError("manual_proof_payment_not_found", "Pembayaran tidak ditemukan", 404);
  }

  if (payment.origin !== "manual_transfer") {
    throw new ManualProofError(
      "manual_proof_not_manual_lane",
      "Hanya pembayaran transfer manual yang menerima bukti transfer",
    );
  }

  const competitionId = await loadCompetitionIdForPayment(payment.id, db);

  assertObjectKeyBelongsToPayment(input.r2Key, competitionId, payment.id);

  const created = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;

    // THE SAME ROW LOCK THE EXPIRY SWEEP TAKES, and taken here for that reason alone.
    //
    // Submitting a bukti transfer and expiring the payment it belongs to are the two writes that
    // must never interleave: a candidate uploading their evidence in the same instant the deadline
    // sweep runs would otherwise end up with a `pending_review` proof against a cancelled
    // registration, having transferred real money. The anchor registration row is the only object
    // both paths touch, so it is where they serialize.
    //
    // Whichever arrives first wins cleanly: the sweep cancels and this submission is refused below,
    // or this submission lands and the sweep re-reads the proof table under the lock and declines.
    const registrationRows = await scoped.execute(
      sql`select status from competition_registrations
          where id = ${payment.registrationId} for update`,
    );

    const [registration] = [...registrationRows] as { status: string }[];

    if (!registration) {
      throw new ManualProofError(
        "manual_proof_payment_not_found",
        "Pembayaran ini tidak lagi terhubung ke pendaftaran mana pun",
        404,
      );
    }

    if (registration.status === "cancelled") {
      throw new ManualProofError(
        "manual_proof_registration_cancelled",
        "Pendaftaran ini sudah dibatalkan, sehingga bukti transfer tidak dapat dikirim",
        409,
      );
    }

    const [created] = await scoped
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
        "Pembayaran ini sudah memiliki bukti transfer — kirim ulang melalui alur revisi",
        409,
      );
    }

    return created;
  });

  // AFTER the commit, never inside it. A queue write inside the transaction would announce a proof
  // that a later rollback erased, and a queue outage would refuse a submission the database
  // accepted.
  await notifyPaymentProofSubmitted(created.paymentId, created.id, created.resubmissionCount, db);

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
      "Pembayaran ini tidak terhubung ke pendaftaran mana pun",
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
  const verified = await db.transaction(async (tx) => {
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
        "Bukti transfer ini tidak sedang menunggu tinjauan — mungkin sudah ditinjau",
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
      throw new ManualProofError("manual_proof_payment_not_found", "Pembayaran tidak ditemukan", 404);
    }

    await recordProofAttempt(tx as unknown as Database, proof, "verified", null);

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

  await notifyPaymentOutcome(verified.paymentId, "verified", {}, db);

  return verified;
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
      "Penolakan harus menyertakan alasan agar peserta tahu apa yang perlu diperbaiki",
    );
  }

  const trimmedReason = reason.trim();

  // The CAS and the history row are one transaction: a rejection recorded on the live row while its
  // attempt failed to reach the history would lose the attempt the moment the candidate resubmits
  // over it, which is precisely the loss the history exists to prevent.
  const rejected = await db.transaction(async (tx) => {
    const [proof] = await tx
      .update(financeManualPaymentProofs)
      .set({
        status: "rejected",
        reviewerUserId,
        rejectionReason: trimmedReason,
        resubmissionAllowed,
        reviewedAt: now,
        updatedAt: now,
      })
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
        "Bukti transfer ini tidak sedang menunggu tinjauan — mungkin sudah ditinjau",
        409,
      );
    }

    await recordProofAttempt(tx as unknown as Database, proof, "rejected", trimmedReason);

    return proof;
  });

  // The reason and the bar both ride along: a rejection notice that omits either tells the payer
  // their proof failed without telling them whether there is anything left for them to do.
  await notifyPaymentOutcome(
    rejected.paymentId,
    "rejected",
    { rejectionReason: trimmedReason, resubmissionAllowed },
    db,
  );

  return rejected;
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
 * Reopens a closed bukti transfer with a replacement file — the candidate-initiated revision loop.
 *
 * TWO ARMS IN ONE CAS, and only one of them is gated:
 *
 *   rejected → pending_review   requires `resubmission_allowed = true`. The organiser looked at the
 *                               evidence and set a bar; this is that bar.
 *   voided   → pending_review   IGNORES the bar, deliberately. A void is platform_ops correcting a
 *                               platform-side or dispute-side mistake, not the organiser ruling on
 *                               the money — and the organiser's bar was set against their own
 *                               rejection, which is a different decision about a different thing.
 *
 * The voided arm exists because without it a void permanently strands the payer: the live row is no
 * longer `pending_review` so nothing is in flight, `submitManualPaymentProof` refuses against the
 * surviving row, and the payment simply runs out its deadline. An undo that leaves the payer with
 * no way to pay is not an undo.
 *
 * BOTH ARMS BUMP `resubmission_count`, and the bumped value is read from this statement's own
 * RETURNING. The attempt segment of the idempotency key is derived from it, so taking it from a
 * prior SELECT would mint attempt two's key from attempt one's count and the second verification
 * would be swallowed as a replay of the first.
 *
 * `rejection_reason` IS cleared here. Each attempt's reason now lives on its own history row, so
 * carrying the previous one forward onto a fresh submission would show the reviewer of attempt two
 * a refusal that belongs to attempt one, with nothing marking it as stale.
 *
 * `submitted_by_user_id` rides in the same WHERE as the status: only the payer refiles their own
 * evidence. The replacement key goes through the same `assertObjectKeyBelongsToPayment` the first
 * submission does, so a resubmission cannot reach an object the original could not have.
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
      "Bukti transfer ini tidak dapat dikirim ulang",
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
      rejectionReason: null,
      submittedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(financeManualPaymentProofs.id, input.proofId),
        eq(financeManualPaymentProofs.submittedByUserId, input.submittedByUserId),
        or(
          and(
            eq(financeManualPaymentProofs.status, "rejected"),
            eq(financeManualPaymentProofs.resubmissionAllowed, true),
          ),
          eq(financeManualPaymentProofs.status, "voided"),
        ),
      ),
    )
    .returning();

  if (!proof) {
    throw new ManualProofError(
      "manual_proof_resubmission_barred",
      "Bukti transfer ini tidak dapat dikirim ulang",
      409,
    );
  }

  // A replacement transfer is a new thing for the organiser to look at, and nothing else tells
  // them: the row they already rejected simply reappears in the queue.
  await notifyPaymentProofSubmitted(proof.paymentId, proof.id, proof.resubmissionCount, db);

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
      "Pembatalan bukti transfer harus menyertakan alasan",
    );
  }

  const trimmedReason = reason.trim();

  return db.transaction(async (tx) => {
    const [proof] = await tx
      .update(financeManualPaymentProofs)
      .set({
        status: "voided",
        reviewerUserId: actorUserId,
        rejectionReason: trimmedReason,
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
        "Hanya bukti transfer yang masih menunggu tinjauan yang dapat dibatalkan",
        409,
      );
    }

    await recordProofAttempt(tx as unknown as Database, proof, "voided", trimmedReason);

    return proof;
  });
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
