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
  financePaymentEvents,
  financePayments,
  institutionAuditLogs,
  type FinanceManualPaymentProofRecord,
} from "@/server/db/schema";
import { appendPaymentEvent } from "@/server/finance/payment-service";
import { foldPaymentEvents } from "@/lib/finance/payment-state";
import { recordFeeAccrual, recordFeeAccrualReversal } from "@/server/finance/fee-accrual-service";
import { mintManualPaymentEventKey } from "@/server/finance/idempotency-key";
import {
  deleteObject,
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  headObject,
  isR2Available,
} from "@/server/storage/r2.client";
import {
  PAYMENT_PROOF_FORMAT_HINT,
  PAYMENT_PROOF_MAX_BYTES,
  paymentProofMimeTypeForFileName,
} from "@/lib/finance/payment-proof-file";
import {
  notifyPaymentOutcome,
  notifyPaymentProofSubmitted,
} from "@/server/finance/payment-notifications";

// THE BUKTI TRANSFER REVIEW LOOP. Services only. The upload, verdict, view and void routes are thin
// wrappers that read a request body and call in here.
//
// EVERY TRANSITION IS AN OPTIMISTIC CAS on the proof's status, and that is the concurrency guard the
// whole manual lane rests on (Rule 25: CAS for a single-row transition). It is NOT the idempotency
// key. The key cannot serve here: `appendPaymentEvent`'s platform arm mints a fresh UUID per call by
// design, so two organisers clicking "verify" at once would write two `succeeded` events (which the
// fold tolerates) and two fee accruals, which is money billed twice. The CAS means exactly one of
// those calls transitions the row and therefore exactly one reaches the accrual write.
//
// EVERY FUNCTION HERE IS SCOPED IN ITS OWN QUERY, and the scope sits in the same WHERE as the CAS
// rather than in a check the caller is trusted to have run first. Two scopes, because there are two
// kinds of actor:
//
//   ORGANISER SIDE  (verify / reject / read): scoped to the institution that owns the proof's
//                   competition. A proof id from another organiser's competition matches no row and
//                   is indistinguishable from one that does not exist.
//   CANDIDATE SIDE  (submit / reopen):        scoped to the person whose money it is. A payer may
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
  // The void found a proof it may not close: verified, or already voided. Deliberately NOT
  // `manual_proof_not_pending`, which would now be a false statement about the row. A rejected
  // proof is not pending and is voidable precisely so a barred payer can be released.
  | "manual_proof_not_voidable"
  | "manual_proof_resubmission_barred"
  | "manual_proof_not_rejected"
  | "manual_proof_reason_required"
  | "manual_proof_object_key_invalid"
  // The request named an action the verdict route does not implement. A malformed request, not a
  // judgement about the proof, which is why it does not borrow `manual_proof_not_pending`, a code
  // that asserts something specific and false about the row's state.
  | "manual_proof_action_unrecognised"
  | "manual_proof_upload_unavailable"
  // Not a refusal. Raised only by an internal invariant assertion; see `recordProofAttempt`.
  | "manual_proof_invariant_violation"
  // The lane is shut because the money already settled one way or the other. Distinct from
  // `manual_proof_registration_cancelled`, which is shut because the participation is gone.
  // A key that named no object. The upload never completed, or never happened.
  | "manual_proof_object_missing"
  | "manual_proof_lane_closed"
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
 * A BUKTI TRANSFER IS NEVER PURGED, AT ANY AGE. It is financial evidence, and the competition
 * ending is not a reason to destroy the record of who paid for it. Nothing may ever list this prefix
 * for deletion; see finance-retention-exclusion.test.ts, which fails if the retention sweep's purge
 * surface grows a path to it.
 */
export const buildManualProofObjectPrefix = (competitionId: string, paymentId: string): string =>
  `payment-proofs/${competitionId}/${paymentId}/`;

/** What the row records about the file, derived from the name and confirmed against storage. */
type ConfirmedProofObject = { contentType: string; fileSizeBytes: number };

/**
 * WHAT WAS ACTUALLY UPLOADED, never what the request said was uploaded.
 *
 * Both facts used to arrive in the request body and were written to the row unexamined, which cost
 * two things.
 *
 * THE CONTENT TYPE went on to be handed to R2 as `ResponseContentType` on an `inline` presigned GET.
 * A payer could declare `text/html` over an image upload and have storage serve executable markup
 * to the organiser reviewing their receipt, or to the finance operator opening it during a dispute,
 * the two highest-privilege humans who touch this lane. It is derived here from the file NAME
 * against the accepted-extension list, and storage's own reported type is not trusted either: that
 * value was set by whoever performed the upload. The bucket is a separate origin today, which is
 * what keeps this out of the app's cookie scope; that changes the day R2 is fronted by a custom
 * domain under the app's own domain, and this function is why that change stays survivable.
 *
 * THE SIZE, and the object's existence, were never checked at all. A key under the right prefix was
 * accepted whether or not anything had been uploaded to it, so a payer could file an attempt with
 * no file behind it, and every later "view" would write an audit row for a read that never happened.
 * Resubmitting one key under two different names and sizes let the payer author their own evidence
 * log, in the table a dispute is adjudicated from.
 *
 * This is the confirmation half of the pipeline the submissions and document lanes already run. The
 * manual lane adopted the upload half and left this out.
 */
const confirmUploadedProofObject = async (
  r2Key: string,
  originalFileName: string,
): Promise<ConfirmedProofObject> => {
  const contentType = paymentProofMimeTypeForFileName(originalFileName);

  if (!contentType) {
    throw new ManualProofError(
      "manual_proof_object_key_invalid",
      `Format berkas bukti transfer tidak didukung. ${PAYMENT_PROOF_FORMAT_HINT}`,
    );
  }

  const head = await headObject(r2Key);

  if (!head) {
    throw new ManualProofError(
      "manual_proof_object_missing",
      "Berkas bukti transfer belum selesai diunggah, silakan unggah ulang",
      404,
    );
  }

  if (head.sizeBytes <= 0 || head.sizeBytes > PAYMENT_PROOF_MAX_BYTES) {
    // Removed rather than left behind: it is unreferenced from this moment on, and nothing sweeps
    // this prefix, because the retention job is deliberately excluded from it.
    await deleteObject(r2Key);
    throw new ManualProofError(
      "manual_proof_object_key_invalid",
      "Ukuran berkas bukti transfer tidak valid",
    );
  }

  return { contentType, fileSizeBytes: head.sizeBytes };
};

// EVERY WRITE PATH IN THIS LANE, AND WHAT EACH ONE REQUIRES OF THE LANE.
//
// The rule, and it is the reason the table exists rather than a list of fixes: A WRITE THAT CAN
// CREATE MONEY REQUIRES THE LANE TO BE OPEN; A WRITE THAT ONLY CLOSES AN ATTEMPT DOES NOT. The
// second half matters as much as the first. Gating the closing verdicts would strand a pending
// proof on a cancelled registration forever, and would disarm the escape hatch at exactly the
// moment it is needed.
//
//   generateManualProofUploadUrl  all four, ENFORCED AT THE ROUTE via canSubmitProof /
//                                 canResubmitProof. The only condition-checking point outside this
//                                 module, and the asymmetry is deliberate: minting a URL writes no
//                                 row, so the check belongs where the request is shaped.
//   submitManualPaymentProof      all four, via requireOpenManualLane.
//   reopenManualPaymentProof      all four, via requireOpenManualLane. A resubmission is a
//                                 submission. The row it writes is indistinguishable from a first
//                                 attempt once written, so the same conditions must hold.
//   verifyManualPaymentProof      all four, via requireOpenManualLane. This is the write that turns
//                                 evidence into money: it appends `succeeded` and accrues a fee.
//   rejectManualPaymentProof      none, deliberately. Refusing evidence creates no money and closes
//                                 an attempt that would otherwise sit open forever.
//   voidManualPaymentProof        none, deliberately. Same reasoning, and it is the operator hatch:
//                                 it has to work when the rest of the lane does not.
//
// Anything added below this line states its row here, or the lane is back to three paths enforcing
// three different rule sets.
//
// THE SAME CHECK APPLIES TO ENTRY PATHS, NOT ONLY WRITE PATHS. Two surfaces have now shipped the
// identical defect, one sibling enforcing less than the other. Resubmission checked none of the
// conditions submission checked, and on the registration page the individual path withheld its
// control under DEC-0170 while the team path let a candidate form a team and invite members into a
// competition that cannot accept one. Wherever individual and team, or submit and resubmit, are
// siblings, they answer to the same condition set or one of them is a hole.

/** The payment a write may proceed against, and the registration row the lock is held on. */
type OpenManualLane = { paymentId: string; registrationId: string };

/**
 * THE MANUAL LANE'S WRITE PRECONDITION. The four conditions `laneOpen` is made of, enforced.
 *
 * `laneOpen` is computed for the candidate's panel to decide which controls to OFFER. Offering is
 * presentation; this is the enforcement, and the two must not be confused. Every write into the
 * lane calls this, because a precondition one sibling checks and another does not is not a
 * precondition. It is a hole with a comment above it. The proof of that: the presign checked all
 * four, submission checked one, resubmission checked none, and a resubmission after an expiry
 * cancellation could carry a registration the platform had already destroyed all the way to a
 * verified payment and a platform fee that nothing in the product can reverse.
 *
 * THE ROW LOCK IS THE POINT. Submitting evidence and expiring the payment it belongs to must never
 * interleave, and the anchor registration row is the only object both paths touch, so it is where
 * they serialize. Whichever arrives first wins cleanly: the sweep cancels and the write is refused
 * here, or the write lands and the sweep re-reads under the lock and declines.
 *
 * RETURNS THE PAYMENT IT VALIDATED, and callers must feed that value into the write they then
 * perform. That is deliberate: it makes calling this AFTER the write a compile error rather than a
 * reordering a reviewer has to notice. There is no harmful move to detect because the ordering is
 * not expressible.
 */
const requireOpenManualLane = async (
  tx: Database,
  paymentId: string,
): Promise<OpenManualLane> => {
  const [payment] = await tx
    .select({ registrationId: financePayments.competitionRegistrationId })
    .from(financePayments)
    .where(eq(financePayments.id, paymentId))
    .limit(1);

  if (!payment?.registrationId) {
    throw new ManualProofError(
      "manual_proof_payment_not_found",
      "Pembayaran ini tidak lagi terhubung ke pendaftaran mana pun",
      404,
    );
  }

  const registrationRows = await tx.execute(
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
      "Pendaftaran ini sudah dibatalkan, sehingga bukti transfer tidak dapat diproses",
      409,
    );
  }

  // FOLDED, never read from a column, because there is no status column to read (DEC-0133). A
  // payment with an `initiated` and a later `failed` has rows in the ledger and has not settled.
  const events = await tx
    .select()
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, paymentId));
  const settled = foldPaymentEvents(events).status;

  if (settled === "succeeded" || settled === "refunded" || settled === "expired") {
    throw new ManualProofError(
      "manual_proof_lane_closed",
      "Pembayaran ini sudah selesai, sehingga bukti transfer tidak dapat diproses",
      409,
    );
  }

  return { paymentId, registrationId: payment.registrationId };
};

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
 *      work, because without it a competition whose id is a string prefix of another's would match.
 *   2. No path segment is `..`. Object keys are literal strings in R2 and `..` resolves to nothing
 *      there, so this is not exploitable against today's storage. It is refused anyway because that
 *      is a property of the CURRENT STORAGE LAYER rather than of the key, and keys travel: a local
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
 * one's verdict, the exact confusion this table exists to prevent.
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
    // INVARIANT ASSERTION, NOT A REFUSAL, and the three markers below are what say so, because a
    // reader who cannot tell those apart will translate this message on the next Indonesian sweep
    // and destroy the only signal it carries.
    //
    //   1. The `INVARIANT:` prefix. Deliberately English: this text is read in Sentry by a
    //      developer, never by a candidate, and an Indonesian sentence here would look like every
    //      other refusal in this file.
    //   2. Its OWN code. Reusing `manual_proof_not_pending`, which it did, made an alert on that
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
 * so a caller-supplied key can only ever be refused, but a presign that signed one would have
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
      "Penyimpanan berkas belum dikonfigurasi sehingga unggahan sementara tidak tersedia",
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
 * payer's bank details and account name, so reading it is an act on their data, and an institution
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
      "Penyimpanan berkas belum dikonfigurasi sehingga bukti transfer tidak dapat dibuka",
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
  // The NAME only. Size and type are read back from storage (see `confirmUploadedProofObject`).
  originalFileName: string;
};

/**
 * Records a candidate's first bukti transfer for a payment.
 *
 * One proof per payment, enforced by a unique index. A second submission is a RESUBMISSION and goes
 * through `reopenManualPaymentProof`, which is the only path that respects the organiser's
 * resubmission bar. Inserting a fresh row here instead would walk straight around it.
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

  const object = await confirmUploadedProofObject(input.r2Key, input.originalFileName);

  const created = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;

    const lane = await requireOpenManualLane(scoped, payment.id);

    const [created] = await scoped
      .insert(financeManualPaymentProofs)
      .values({
        // From the precondition, not from `payment`, so an insert placed above the check is a
        // compile error rather than an ordering a reviewer has to catch.
        paymentId: lane.paymentId,
        competitionId,
        submittedByUserId: input.submittedByUserId,
        status: "pending_review",
        r2Key: input.r2Key,
        originalFileName: input.originalFileName,
        fileSizeBytes: object.fileSizeBytes,
        contentType: object.contentType,
      })
      .onConflictDoNothing({ target: financeManualPaymentProofs.paymentId })
      .returning();

    if (!created) {
      throw new ManualProofError(
        "manual_proof_already_submitted",
        "Pembayaran ini sudah memiliki bukti transfer, kirim ulang melalui alur revisi",
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
 *   1. CAS the proof `pending_review` → `verified`. Losing the CAS ends the call, which is what
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
    // A CANCELLED REGISTRATION CANNOT BECOME PAID. Resolved and locked BEFORE the CAS, because the
    // verdict is the write that turns a proof into money: it appends `succeeded` and accrues a
    // platform fee, and under DEC-0133 both are append-only. There is no participation for that
    // money to attach to, and no product path that can walk the accrual back, so it has to be
    // refused here rather than corrected afterwards.
    //
    // Reached through the proof's own payment rather than a caller-supplied id, so a verdict cannot
    // be checked against one payment's lane while landing on another payment's proof.
    const [target] = await tx
      .select({
        paymentId: financeManualPaymentProofs.paymentId,
        status: financeManualPaymentProofs.status,
      })
      .from(financeManualPaymentProofs)
      .where(eq(financeManualPaymentProofs.id, proofId))
      .limit(1);

    if (!target) {
      throw new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404);
    }

    // ANSWERED BEFORE THE LANE CHECK, and the order is the whole point. A second verify closes the
    // lane by its own success (the first one appended `succeeded`) so asking the lane first would
    // tell an organiser who clicked twice that the payment had settled, when what they need to know
    // is that their own earlier verdict is already recorded. This is a nicety of wording, not a
    // guard: the CAS below still refuses the concurrent case, which is the one that races.
    if (target.status !== "pending_review") {
      throw new ManualProofError(
        "manual_proof_not_pending",
        "Bukti transfer ini tidak sedang menunggu tinjauan, mungkin sudah ditinjau",
        409,
      );
    }

    const lane = await requireOpenManualLane(tx as unknown as Database, target.paymentId);

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
      // same WHERE, so accepting another organiser's transfer, and accruing a fee against their
      // institution, matches nothing either.
      .where(
        and(
          eq(financeManualPaymentProofs.id, proofId),
          // From the precondition, so the CAS cannot be lifted above it: `lane` is not in scope
          // up there. The ordering is a compile error, not a convention.
          eq(financeManualPaymentProofs.paymentId, lane.paymentId),
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
        "Bukti transfer ini tidak sedang menunggu tinjauan, mungkin sudah ditinjau",
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
      // A named human accepted this transfer, so the actor is that human. Positional by design,
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
 * merely a UI state. The bar is enforced in `reopenManualPaymentProof`'s CAS, since hiding a button
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
        "Bukti transfer ini tidak sedang menunggu tinjauan, mungkin sudah ditinjau",
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
  // The NAME only. Size and type are read back from storage (see `confirmUploadedProofObject`).
  originalFileName: string;
};

/**
 * Reopens a closed bukti transfer with a replacement file. The candidate-initiated revision loop.
 *
 * TWO ARMS IN ONE CAS, and only one of them is gated:
 *
 *   rejected → pending_review   requires `resubmission_allowed = true`. The organiser looked at the
 *                               evidence and set a bar; this is that bar.
 *   voided   → pending_review   IGNORES the bar, deliberately. A void is platform_ops correcting a
 *                               platform-side or dispute-side mistake, not the organiser ruling on
 *                               the money, and the organiser's bar was set against their own
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

  const object = await confirmUploadedProofObject(input.r2Key, input.originalFileName);

  const proof = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;

    // THE SAME PRECONDITION THE FIRST SUBMISSION TAKES. A resubmission is a submission. The row it
    // writes is indistinguishable from a first attempt once written, so a condition that refuses one
    // must refuse the other. Without it a rejected proof could be refiled onto a registration the
    // expiry sweep had already cancelled, then verified, appending `succeeded` and accruing a
    // platform fee against a participation that no longer exists.
    const lane = await requireOpenManualLane(scoped, existing.paymentId);

    const [reopened] = await scoped
      .update(financeManualPaymentProofs)
      .set({
        status: "pending_review",
        r2Key: input.r2Key,
        originalFileName: input.originalFileName,
        fileSizeBytes: object.fileSizeBytes,
        contentType: object.contentType,
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
          // Pinned to the payment the precondition validated, so the CAS cannot be reordered above
          // it: `lane` does not exist yet up there.
          eq(financeManualPaymentProofs.paymentId, lane.paymentId),
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

    if (!reopened) {
      throw new ManualProofError(
        "manual_proof_resubmission_barred",
        "Bukti transfer ini tidak dapat dikirim ulang",
        409,
      );
    }

    return reopened;
  });

  // A replacement transfer is a new thing for the organiser to look at, and nothing else tells
  // them: the row they already rejected simply reappears in the queue.
  await notifyPaymentProofSubmitted(proof.paymentId, proof.id, proof.resubmissionCount, db);

  return proof;
};

/**
 * Closes out an unsettled bukti transfer without ruling on the money. The DEC-0132 escape hatch,
 * for `platform_ops` only.
 *
 * ACCEPTS A REJECTED PROOF AS WELL AS A PENDING ONE, AND THAT IS THE WHOLE POINT OF THE SECOND ARM.
 * A rejection carrying `resubmission_allowed = false` was otherwise terminal: the payer cannot
 * resubmit, cannot cancel (a proof exists, so that affordance is withheld), the organiser's queue
 * withholds every control on a decided proof, and this function refused because the row was no
 * longer pending. The registration then expired and nothing in the product could prevent it, while
 * the copy told the payer to contact an organiser who had no control to help them with.
 *
 * `reopenManualPaymentProof` already accepts `voided` and already bypasses the organiser's bar, so
 * once a rejected proof can be voided the documented path works end to end with no new concept.
 * Before this, that bar-bypass arm was unreachable for every proof that had a bar: by the time one
 * existed the proof was `rejected`, and `rejected` could not be voided.
 *
 * WHAT MAKES THE ORGANISER'S BAR SAFE TO OFFER. An organiser may refuse a resubmission because
 * somebody can still undo it. Without this arm the checkbox hands a permanent sentence to a
 * reviewer who is only trying to stop a fourth blurred photograph.
 *
 * NO FINANCE EVENT IS WRITTEN, and that is the defining property. Nothing was confirmed received,
 * so there is nothing to record as having succeeded, failed or been refunded; writing any event
 * here would put a claim in an append-only ledger that no one is in a position to make. The proof
 * simply stops being in flight, which unblocks the DEC-0132 unpublish guard.
 *
 * `reason` is mandatory and the caller is responsible for the audit row. This function writes the
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
        // THE ATTEMPT INDEX THIS VOID WILL OCCUPY, decided from the state it is closing.
        //
        // On a pending proof nothing has been filed at the current index yet, so the void takes it
        // and the numbering stays contiguous. On a REJECTED one the rejection already filed there,
        // and reusing the index violates the attempts table's (proof_id, attempt_number) unique
        // index, and the void would fail on exactly the population it exists to rescue.
        //
        // The right-hand side reads the PRE-UPDATE row, which is what lets one statement decide
        // this without a second read to race against.
        resubmissionCount: sql`case when ${financeManualPaymentProofs.status} = 'rejected' then ${financeManualPaymentProofs.resubmissionCount} + 1 else ${financeManualPaymentProofs.resubmissionCount} end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(financeManualPaymentProofs.id, proofId),
          // BOTH STATES A VOID MAY CLOSE, and `verified` is deliberately absent from the list.
          // Voiding a verified proof would leave a `succeeded` ledger event standing against a
          // voided row, and no reachable path in the product reverses that event.
          inArray(financeManualPaymentProofs.status, ["pending_review", "rejected"]),
        ),
      )
      .returning();

    if (!proof) {
      throw new ManualProofError(
        "manual_proof_not_voidable",
        "Hanya bukti transfer yang belum diverifikasi yang dapat dibatalkan",
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
