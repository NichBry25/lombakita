import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/recruiter-verification/recruiter-verification-service");

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { enqueueRecruiterVerificationRejected } from "@/server/async/enqueue";
import { getDb, type Database } from "@/server/db/client";
import {
  platformOpsAuditLogs,
  recruiterVerificationDocuments,
  recruiterVerificationSubmissions,
  users,
  type RecruiterVerificationDocumentRecord,
  type RecruiterVerificationSubmissionRecord,
} from "@/server/db/schema";
import {
  deriveCorporateEmailDomainFlag,
  RecruiterVerificationError,
  type RecruiterVerificationInput,
} from "@/server/recruiter-verification/recruiter-verification-core";
import {
  buildContentDisposition,
  extensionMatchesMimeType,
  formatVerificationDownloadName,
  getFileExtension,
  isAllowedDocumentMimeType,
  mimeTypeForExtension,
  sanitizeFileName,
  VERIFICATION_DOCUMENT_MAX_BYTES,
} from "@/lib/recruiter-verification/verification-document";
import { detectFileType } from "@/server/storage/file-signature";
import {
  deleteObject,
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  headObject,
  isR2Available,
  listObjects,
  readObjectHead,
} from "@/server/storage/r2.client";

// Recruiter trust verification — persistence layer.
// A submission is the reviewable unit: created when a recruiter completes the affiliation form,
// reviewed by platform ops. Approval elevates users.recruiter_verification_tier to `elevated`
// ("Trusted Recruiter") in the same transaction as the status flip, plus an audit row (audit
// requirement for platform_ops actions). The partial unique index
// recruiter_verification_submissions_user_pending_unique_idx enforces at most one open
// submission per account at the DB level.

const PENDING_UNIQUE_CONSTRAINT = "recruiter_verification_submissions_user_pending_unique_idx";

const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  const e = error as { code?: string; constraint?: string; constraint_name?: string };
  if (e.code !== "23505") return false;
  if (!constraint) return true;
  return e.constraint === constraint || e.constraint_name === constraint;
};

const buildInsertValues = (userId: string, input: RecruiterVerificationInput) => ({
  userId,
  fullName: input.fullName,
  mobileNumber: input.mobileNumber,
  corporateEmail: input.corporateEmail,
  emailDomainFlag: deriveCorporateEmailDomainFlag(input.corporateEmail),
});

// Inserts the recruiter verification submission inside an existing transaction — used by the
// registration and second-role verification paths so the submission lands atomically with the
// recruiter role grant. A pre-existing open submission is left untouched.
export const createRecruiterVerificationSubmissionInTransaction = async (
  tx: Database,
  userId: string,
  input: RecruiterVerificationInput,
): Promise<void> => {
  await tx
    .insert(recruiterVerificationSubmissions)
    .values(buildInsertValues(userId, input))
    .onConflictDoNothing();
};

// Withdraws the account's queued submission back into `draft` so the applicant can revise it.
// This is what keeps the reviewer's view stable: a pending submission is frozen, and the only way
// to change it is to first take it out of the queue. The CAS on `pending_review` settles the
// simultaneous case — if a reviewer's verdict commits first, the withdrawal is refused and the
// applicant sees the verdict instead.
// Documents and the affiliation details carry over untouched; only the status moves.
export const withdrawRecruiterVerification = async (
  userId: string,
  db: Database = getDb(),
): Promise<RecruiterVerificationSubmissionRecord> => {
  const [withdrawn] = await db
    .update(recruiterVerificationSubmissions)
    .set({ status: "draft" })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "pending_review"),
      ),
    )
    .returning();

  if (!withdrawn) {
    throw new RecruiterVerificationError(
      "recruiter_verification_not_found",
      "This account has no verification submission awaiting review",
    );
  }

  logger.info("recruiter_verification.withdrawn", { submissionId: withdrawn.id, userId });

  return withdrawn;
};

// Moves the account's editable submission into the review queue: a draft the applicant withdrew,
// or a rejected submission they are reopening. Either way the SAME row moves, so the attached
// documents travel with it. submitted_at is bumped to record when this attempt was sent;
// first_submitted_at is deliberately left alone, so the applicant keeps the queue position they
// earned when they first applied.
// A rejected row additionally requires `resubmission_allowed` and increments the resubmission
// counter; both conditions live in the CAS, so a reviewer's bar cannot be bypassed by calling the
// endpoint directly. The rejection reason is deliberately retained — the next reviewer needs to
// see what the previous verdict objected to.
// Returns null when the account has no editable submission; the caller files a first one instead.
const queueEditableSubmissionForReview = async (
  userId: string,
  input: RecruiterVerificationInput,
  db: Database,
): Promise<RecruiterVerificationSubmissionRecord | null> => {
  const editableId = await findEditableSubmissionIdForUser(userId, db);
  if (!editableId) return null;

  const [queued] = await db
    .update(recruiterVerificationSubmissions)
    .set({
      ...buildInsertValues(userId, input),
      status: "pending_review",
      submittedAt: sql`now()`,
      resubmissionCount: sql`
        case when ${recruiterVerificationSubmissions.status} = 'rejected'
          then ${recruiterVerificationSubmissions.resubmissionCount} + 1
          else ${recruiterVerificationSubmissions.resubmissionCount}
        end`,
    })
    .where(
      and(
        eq(recruiterVerificationSubmissions.id, editableId),
        inArray(recruiterVerificationSubmissions.status, [...EDITABLE_SUBMISSION_STATUSES]),
        // Only constrains the rejected arm: a draft always carries the default `true`.
        eq(recruiterVerificationSubmissions.resubmissionAllowed, true),
      ),
    )
    .returning();

  if (queued) return queued;

  // The CAS lost. Re-read to report WHY rather than guessing — a bar imposed between the read and
  // the write and a concurrent submission produce the same empty result but different advice.
  const [current] = await db
    .select({
      status: recruiterVerificationSubmissions.status,
      resubmissionAllowed: recruiterVerificationSubmissions.resubmissionAllowed,
    })
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.id, editableId))
    .limit(1);

  if (current && !current.resubmissionAllowed) {
    throw new RecruiterVerificationError(
      "recruiter_verification_resubmission_blocked",
      "This account may not submit another verification request",
    );
  }

  throw new RecruiterVerificationError(
    "recruiter_verification_already_pending",
    "A verification submission is already awaiting review",
  );
};

// Standalone submission path for the recruiter dashboard. Moves the account's existing editable
// submission (a withdrawn draft, or a rejected one being reopened) into the queue, keeping its
// documents and history on the same row; files a fresh submission when there is none. Refuses when
// the account is already Trusted, when a submission is already awaiting review, and when the
// reviewer barred the account from reapplying.
export const submitRecruiterVerification = async (
  userId: string,
  input: RecruiterVerificationInput,
  db: Database = getDb(),
): Promise<RecruiterVerificationSubmissionRecord> => {
  const [account] = await db
    .select({ recruiterVerificationTier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!account) {
    throw new RecruiterVerificationError("recruiter_verification_not_found", "Account not found");
  }
  if (account.recruiterVerificationTier === "elevated") {
    throw new RecruiterVerificationError(
      "recruiter_already_trusted",
      "This account is already a Trusted Recruiter",
    );
  }

  const queued = await queueEditableSubmissionForReview(userId, input, db);
  if (queued) return queued;

  try {
    const [row] = await db
      .insert(recruiterVerificationSubmissions)
      .values(buildInsertValues(userId, input))
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  } catch (error) {
    if (isUniqueViolation(error, PENDING_UNIQUE_CONSTRAINT)) {
      throw new RecruiterVerificationError(
        "recruiter_verification_already_pending",
        "A verification submission is already awaiting review",
      );
    }
    throw error;
  }
};

export type RecruiterVerificationWithDocuments = {
  submission: RecruiterVerificationSubmissionRecord;
  documents: RecruiterVerificationDocumentRecord[];
};

// Latest submission (any status) plus its documents — powers the dashboard status panel.
// Returns null when the account has never submitted (e.g. OAuth signup pre-form).
export const getLatestRecruiterVerificationForUser = async (
  userId: string,
  db: Database = getDb(),
): Promise<RecruiterVerificationWithDocuments | null> => {
  const [submission] = await db
    .select()
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.userId, userId))
    .orderBy(desc(recruiterVerificationSubmissions.submittedAt))
    .limit(1);

  if (!submission) return null;

  const documents = await db
    .select()
    .from(recruiterVerificationDocuments)
    .where(eq(recruiterVerificationDocuments.submissionId, submission.id))
    .orderBy(desc(recruiterVerificationDocuments.createdAt));

  return { submission, documents };
};

const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 300;
const PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = 300;
// Bytes read from the head of an uploaded object for magic-byte inspection — every accepted format
// carries its signature well within this window.
const SIGNATURE_READ_BYTES = 4096;

const assertStorageAvailable = (): void => {
  if (!isR2Available()) {
    throw new RecruiterVerificationError(
      "recruiter_verification_storage_unavailable",
      "Document storage is unavailable",
    );
  }
};

// The statuses in which the applicant owns their submission and may change its documents. A
// submission is editable exactly when the reviewer cannot act on it, which is what makes the two
// sides race-free: `draft` (withdrawn from the queue for revision) and `rejected` (awaiting a
// reopen). `pending_review` is frozen — the reviewer is deciding on this document set and it must
// not move under them; the applicant withdraws first. `approved` is frozen permanently, because
// its documents are the evidence the approval rests on.
const EDITABLE_SUBMISSION_STATUSES = ["draft", "rejected"] as const;

// Returns the id of the submission the account may currently attach documents to, or null when it
// has none. A draft wins over a rejected row; among rejected history rows the most recent wins.
export const findEditableSubmissionIdForUser = async (
  userId: string,
  db: Database = getDb(),
): Promise<string | null> => {
  const [editable] = await db
    .select({ id: recruiterVerificationSubmissions.id })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...EDITABLE_SUBMISSION_STATUSES]),
      ),
    )
    .orderBy(
      sql`(${recruiterVerificationSubmissions.status} = 'draft') desc`,
      desc(recruiterVerificationSubmissions.submittedAt),
    )
    .limit(1);

  return editable?.id ?? null;
};

// Resolves the caller's editable submission id, or 404s.
const requireEditableSubmissionId = async (userId: string, db: Database): Promise<string> => {
  const editableId = await findEditableSubmissionIdForUser(userId, db);
  if (!editableId) {
    throw new RecruiterVerificationError(
      "recruiter_verification_not_found",
      "This account has no verification submission open for edits",
    );
  }
  return editableId;
};

// Best-effort garbage collection of orphaned upload objects for one submission. An object is
// orphaned when it sits under the submission's R2 prefix but no document row references it — the
// result of an upload that was PUT to R2 but never finalized, or a replaced attempt. Never throws:
// a storage hiccup must not break the upload or review it runs beside. `respectAge` skips objects
// younger than the upload window so an in-flight upload from another tab is never deleted; the
// terminal review sweep passes false because no new upload can arrive once the submission leaves
// the pending queue.
export const sweepOrphanedSubmissionObjects = async (
  userId: string,
  submissionId: string,
  options: { respectAge: boolean },
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;

  const prefix = `recruiter-verification/${userId}/${submissionId}/`;
  try {
    const objects = await listObjects(prefix);
    if (objects.length === 0) return;

    const rows = await db
      .select({ r2Key: recruiterVerificationDocuments.r2Key })
      .from(recruiterVerificationDocuments)
      .where(eq(recruiterVerificationDocuments.submissionId, submissionId));
    const referenced = new Set(rows.map((row) => row.r2Key));

    const cutoff = Date.now() - PRESIGNED_UPLOAD_EXPIRY_SECONDS * 1000;
    for (const object of objects) {
      if (referenced.has(object.key)) continue;
      if (options.respectAge && object.lastModified && object.lastModified.getTime() > cutoff) {
        continue;
      }
      await deleteObject(object.key);
    }
  } catch (error) {
    logger.warn("recruiter_verification.orphan_sweep_failed", {
      submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Account-level entry point for the sweep: reclaims orphaned upload objects for the account's
// editable submission, if it has one. Used by the platform-ops manual tier-elevation path, which
// turns an account Trusted without going through the review flow's terminal sweep. No-op when the
// account has no editable submission or storage is unconfigured; never throws.
export const sweepOrphanedObjectsForAccount = async (
  userId: string,
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;
  try {
    const submissionId = await findEditableSubmissionIdForUser(userId, db);
    if (!submissionId) return;
    await sweepOrphanedSubmissionObjects(userId, submissionId, { respectAge: true }, db);
  } catch (error) {
    logger.warn("recruiter_verification.account_orphan_sweep_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export type PreparedDocumentUpload = { uploadUrl: string; r2Key: string };

// Presign step of the affiliation-document upload. Validates the declared file against the
// allowlist (extension ↔ type agreement, size cap) and returns a presigned PUT URL plus the
// server-chosen R2 key. No document row is written here — the row is created only after the
// finalize step has inspected the actual uploaded bytes, so an abandoned or forged upload never
// becomes a visible document. The declared values are advisory at this stage.
export const prepareVerificationDocumentUpload = async (
  userId: string,
  file: { originalFileName: string; contentType: string; fileSizeBytes: number },
  db: Database = getDb(),
): Promise<PreparedDocumentUpload> => {
  assertStorageAvailable();

  const mimeForExtension = mimeTypeForExtension(getFileExtension(file.originalFileName));
  if (!mimeForExtension) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_type_not_allowed",
      "Only PDF, JPG, PNG, or WebP files are accepted",
    );
  }
  if (!isAllowedDocumentMimeType(file.contentType) || file.contentType !== mimeForExtension) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_type_not_allowed",
      "The declared file type does not match its extension",
    );
  }
  if (!Number.isFinite(file.fileSizeBytes) || file.fileSizeBytes <= 0) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_invalid",
      "The file is empty",
    );
  }
  if (file.fileSizeBytes > VERIFICATION_DOCUMENT_MAX_BYTES) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_too_large",
      "The file exceeds the 10 MB limit",
    );
  }

  const editableId = await requireEditableSubmissionId(userId, db);

  // Reclaim any object left behind by an earlier abandoned or replaced upload before minting a new
  // one, so orphans do not accumulate across attempts.
  await sweepOrphanedSubmissionObjects(userId, editableId, { respectAge: true }, db);

  const r2Key = `recruiter-verification/${userId}/${editableId}/${crypto.randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    r2Key,
    file.contentType,
    PRESIGNED_UPLOAD_EXPIRY_SECONDS,
  );
  return { uploadUrl, r2Key };
};

// Finalize step: run after the browser has PUT the file to R2. Verifies the stored object against
// the real, server-observed truth — its actual byte size (HEAD) and its magic-byte-detected type
// (a ranged read of the header) — and only then writes the document row. A file whose bytes are
// not an accepted type, whose type disagrees with its extension, or that exceeds the size cap is
// deleted from storage and rejected; no row is created. The persisted content type is the detected
// one, never the client-declared value.
export const finalizeVerificationDocumentUpload = async (
  userId: string,
  input: { r2Key: string; originalFileName: string },
  db: Database = getDb(),
): Promise<RecruiterVerificationDocumentRecord> => {
  assertStorageAvailable();

  const editableId = await requireEditableSubmissionId(userId, db);
  const expectedPrefix = `recruiter-verification/${userId}/${editableId}/`;
  if (!input.r2Key.startsWith(expectedPrefix)) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_invalid",
      "The upload key is not scoped to this submission",
    );
  }

  const head = await headObject(input.r2Key);
  if (!head) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_not_found",
      "The uploaded file was not found in storage",
    );
  }
  if (head.sizeBytes <= 0 || head.sizeBytes > VERIFICATION_DOCUMENT_MAX_BYTES) {
    await deleteObject(input.r2Key);
    throw new RecruiterVerificationError(
      "recruiter_verification_document_too_large",
      "The file exceeds the 10 MB limit",
    );
  }

  const headBytes = await readObjectHead(input.r2Key, SIGNATURE_READ_BYTES);
  const detected = detectFileType(headBytes);
  if (!detected || !extensionMatchesMimeType(input.originalFileName, detected)) {
    await deleteObject(input.r2Key);
    throw new RecruiterVerificationError(
      "recruiter_verification_document_invalid",
      "The file content does not match an accepted document type",
    );
  }

  const [row] = await db
    .insert(recruiterVerificationDocuments)
    .values({
      submissionId: editableId,
      r2Key: input.r2Key,
      originalFileName: sanitizeFileName(input.originalFileName),
      fileSizeBytes: head.sizeBytes,
      contentType: detected,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");

  // Reclaim any prior un-finalized upload for this submission now that a valid document exists.
  await sweepOrphanedSubmissionObjects(userId, editableId, { respectAge: true }, db);

  return row;
};

// Removes one of the caller's own affiliation documents. The document must hang off the caller's
// editable submission: a document attached to an approved submission is evidence the reviewer
// acted on and is not removable, and a document belonging to another account is indistinguishable
// from one that does not exist (404 either way). The row is deleted first and the stored object
// after, so a storage failure leaves an orphan the sweep reclaims rather than a row pointing at
// bytes that are already gone.
export const deleteVerificationDocumentForUser = async (
  userId: string,
  documentId: string,
  db: Database = getDb(),
): Promise<void> => {
  const editableId = await requireEditableSubmissionId(userId, db);

  const [deleted] = await db
    .delete(recruiterVerificationDocuments)
    .where(
      and(
        eq(recruiterVerificationDocuments.id, documentId),
        eq(recruiterVerificationDocuments.submissionId, editableId),
      ),
    )
    .returning({ r2Key: recruiterVerificationDocuments.r2Key });

  if (!deleted) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_not_found",
      "Document not found",
    );
  }

  if (!isR2Available()) return;
  try {
    await deleteObject(deleted.r2Key);
  } catch (error) {
    logger.warn("recruiter_verification.document_object_delete_failed", {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export type VerificationDocumentUrl = { url: string };

// Platform-ops read access to an affiliation document. Mints a short-lived presigned GET URL with
// a bound response content type (the validated type, so the browser never sniffs) and a
// Content-Disposition: `inline` to view in a browser tab, or `attachment` with the
// `<username>_verification_<original name>` filename to download. 404 when the document id is
// unknown. Authorization (platform_ops) is enforced at the route.
export const resolveVerificationDocumentUrlForOps = async (
  documentId: string,
  disposition: "inline" | "attachment",
  db: Database = getDb(),
): Promise<VerificationDocumentUrl> => {
  assertStorageAvailable();

  const [doc] = await db
    .select({
      r2Key: recruiterVerificationDocuments.r2Key,
      originalFileName: recruiterVerificationDocuments.originalFileName,
      contentType: recruiterVerificationDocuments.contentType,
      username: users.username,
    })
    .from(recruiterVerificationDocuments)
    .innerJoin(
      recruiterVerificationSubmissions,
      eq(recruiterVerificationSubmissions.id, recruiterVerificationDocuments.submissionId),
    )
    .innerJoin(users, eq(users.id, recruiterVerificationSubmissions.userId))
    .where(eq(recruiterVerificationDocuments.id, documentId))
    .limit(1);

  if (!doc) {
    throw new RecruiterVerificationError(
      "recruiter_verification_document_not_found",
      "Document not found",
    );
  }

  const dispositionFileName =
    disposition === "attachment"
      ? formatVerificationDownloadName(doc.username, doc.originalFileName)
      : doc.originalFileName;

  const url = await generatePresignedGetUrl(doc.r2Key, PRESIGNED_DOWNLOAD_EXPIRY_SECONDS, {
    responseContentType: doc.contentType,
    responseContentDisposition: buildContentDisposition(disposition, dispositionFileName),
  });
  return { url };
};

// Vouch signal: called when the user accepts an owner/staff invitation from an institution with
// a Trusted owner. Sets vouched_at on the open submission if one exists and is not already
// vouched. A withdrawn draft counts as open — the vouch is earned when the invitation is accepted,
// and it must survive until the applicant sends the submission back to the queue. Returns true
// when a row was marked. Never throws domain errors — the caller treats this as a fire-and-forget
// priority bump.
export const markRecruiterSubmissionVouched = async (
  userId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const updated = await db
    .update(recruiterVerificationSubmissions)
    .set({ vouchedAt: sql`now()` })
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, ["draft", "pending_review"]),
        isNull(recruiterVerificationSubmissions.vouchedAt),
      ),
    )
    .returning({ id: recruiterVerificationSubmissions.id });

  return updated.length > 0;
};

export type PendingVerificationDocument = {
  id: string;
  originalFileName: string;
  contentType: string;
};

export type PendingRecruiterVerificationEntry = {
  submission: RecruiterVerificationSubmissionRecord;
  submitter: { email: string | null; username: string | null; name: string | null };
  hasDocuments: boolean;
  documents: PendingVerificationDocument[];
};

// Review queue for platform ops. Carries two groups: submissions awaiting review, and rejected
// submissions the recruiter may still reopen — the latter stay visible because their documents
// remain editable, so a reviewer can watch a recruiter revise their evidence and can lift a
// resubmission bar they set earlier.
// Awaiting-review rows always sort above rejected ones. Within the awaiting group the existing
// priority order holds: vouched first, then corporate email domain, then documents attached, then
// oldest first — where "oldest" means first_submitted_at, the moment the account first entered the
// queue. Ordering deliberately ignores submitted_at so that withdrawing to fix a document, or
// reopening after a rejection, does not send the applicant to the back of the line.
// Priority reorders the queue only — approval is always a human decision. Each entry carries its
// attached documents so the reviewer can view or download the proof inline.
export const listRecruiterVerificationQueue = async (
  db: Database = getDb(),
): Promise<PendingRecruiterVerificationEntry[]> => {
  const hasDocuments = sql<boolean>`exists (
    select 1 from ${recruiterVerificationDocuments}
    where ${recruiterVerificationDocuments.submissionId} = ${recruiterVerificationSubmissions.id}
  )`;

  const rows = await db
    .select({
      submission: recruiterVerificationSubmissions,
      email: users.email,
      username: users.username,
      name: users.name,
      hasDocuments,
    })
    .from(recruiterVerificationSubmissions)
    .innerJoin(users, eq(users.id, recruiterVerificationSubmissions.userId))
    .where(inArray(recruiterVerificationSubmissions.status, ["pending_review", "rejected"]))
    .orderBy(
      sql`(${recruiterVerificationSubmissions.status} = 'pending_review') desc`,
      sql`(${recruiterVerificationSubmissions.vouchedAt} is not null) desc`,
      sql`(${recruiterVerificationSubmissions.emailDomainFlag} is true) desc`,
      sql`${hasDocuments} desc`,
      recruiterVerificationSubmissions.firstSubmittedAt,
    );

  if (rows.length === 0) return [];

  const submissionIds = rows.map((row) => row.submission.id);
  const documentRows = await db
    .select({
      id: recruiterVerificationDocuments.id,
      submissionId: recruiterVerificationDocuments.submissionId,
      originalFileName: recruiterVerificationDocuments.originalFileName,
      contentType: recruiterVerificationDocuments.contentType,
    })
    .from(recruiterVerificationDocuments)
    .where(inArray(recruiterVerificationDocuments.submissionId, submissionIds))
    .orderBy(desc(recruiterVerificationDocuments.createdAt));

  const documentsBySubmission = new Map<string, PendingVerificationDocument[]>();
  for (const document of documentRows) {
    const list = documentsBySubmission.get(document.submissionId) ?? [];
    list.push({
      id: document.id,
      originalFileName: document.originalFileName,
      contentType: document.contentType,
    });
    documentsBySubmission.set(document.submissionId, list);
  }

  return rows.map((row) => ({
    submission: row.submission,
    submitter: { email: row.email, username: row.username, name: row.name },
    hasDocuments: row.hasDocuments,
    documents: documentsBySubmission.get(row.submission.id) ?? [],
  }));
};

// Platform-ops reversal of the resubmission bar set at rejection time. Applies to a rejected
// submission only: a pending one has nothing to reopen, and an approved one is past the question.
// Writes the audit row in the same transaction as the flip, and no-ops idempotently when the flag
// already holds the requested value so a double click never files a second audit entry.
export const setRecruiterResubmissionAllowed = async (
  reviewerUserId: string,
  submissionId: string,
  allowed: boolean,
  db: Database = getDb(),
): Promise<void> => {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(recruiterVerificationSubmissions)
      .set({ resubmissionAllowed: allowed })
      .where(
        and(
          eq(recruiterVerificationSubmissions.id, submissionId),
          eq(recruiterVerificationSubmissions.status, "rejected"),
          ne(recruiterVerificationSubmissions.resubmissionAllowed, allowed),
        ),
      )
      .returning({ userId: recruiterVerificationSubmissions.userId });

    if (!updated) {
      const [existing] = await tx
        .select({
          status: recruiterVerificationSubmissions.status,
          resubmissionAllowed: recruiterVerificationSubmissions.resubmissionAllowed,
        })
        .from(recruiterVerificationSubmissions)
        .where(eq(recruiterVerificationSubmissions.id, submissionId))
        .limit(1);

      if (!existing) {
        throw new RecruiterVerificationError(
          "recruiter_verification_not_found",
          "Verification submission not found",
        );
      }
      if (existing.status !== "rejected") {
        throw new RecruiterVerificationError(
          "recruiter_verification_already_reviewed",
          "Resubmission can only be changed on a rejected submission",
        );
      }
      return;
    }

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId: reviewerUserId,
      targetUserId: updated.userId,
      eventType: allowed
        ? "recruiter_verification.resubmission_allowed"
        : "recruiter_verification.resubmission_blocked",
      metadata: { submissionId },
    });
  });

  logger.info("recruiter_verification.resubmission_flag_changed", {
    submissionId,
    reviewerUserId,
    allowed,
  });
};

export type RecruiterVerificationReviewResult = {
  submissionId: string;
  userId: string;
  status: "approved" | "rejected";
};

// Platform-ops review decision. One transaction: CAS status flip (only from pending_review),
// tier elevation on approval, and the platform_ops audit row. Rejection requires a reason, stored
// on the submission and shown to the recruiter, and carries the reviewer's decision on whether the
// recruiter may reopen the submission and try again (allowed by default).
// `allowResubmission` and `db` are an options object rather than trailing positional parameters:
// a positional boolean ahead of `db` is silently satisfied by a `db as never` test double, so a
// call site that meant to pass the database would bind it to the flag and typecheck cleanly.
export const reviewRecruiterVerification = async (
  reviewerUserId: string,
  submissionId: string,
  decision: "approve" | "reject",
  rejectionReason: string | null,
  options: { allowResubmission?: boolean; db?: Database } = {},
): Promise<RecruiterVerificationReviewResult> => {
  const allowResubmission = options.allowResubmission ?? true;
  const db = options.db ?? getDb();
  const cleanReason = rejectionReason?.trim() || null;
  if (decision === "reject" && !cleanReason) {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      "A rejection reason is required",
      { fields: ["rejectionReason"] },
    );
  }

  const targetStatus = decision === "approve" ? ("approved" as const) : ("rejected" as const);

  const result = await db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(recruiterVerificationSubmissions)
      .set({
        status: targetStatus,
        reviewerUserId,
        reviewedAt: sql`now()`,
        rejectionReason: decision === "reject" ? cleanReason : null,
        resubmissionAllowed: decision === "reject" ? allowResubmission : true,
      })
      .where(
        and(
          eq(recruiterVerificationSubmissions.id, submissionId),
          eq(recruiterVerificationSubmissions.status, "pending_review"),
        ),
      )
      .returning({
        userId: recruiterVerificationSubmissions.userId,
        resubmissionCount: recruiterVerificationSubmissions.resubmissionCount,
      });

    if (!flipped) {
      const [existing] = await tx
        .select({ id: recruiterVerificationSubmissions.id })
        .from(recruiterVerificationSubmissions)
        .where(eq(recruiterVerificationSubmissions.id, submissionId))
        .limit(1);
      if (!existing) {
        throw new RecruiterVerificationError(
          "recruiter_verification_not_found",
          "Verification submission not found",
        );
      }
      throw new RecruiterVerificationError(
        "recruiter_verification_already_reviewed",
        "This submission has already been reviewed",
      );
    }

    if (decision === "approve") {
      // Idempotent elevation: no-op when a parallel path already elevated the account.
      await tx
        .update(users)
        .set({ recruiterVerificationTier: "elevated", updatedAt: sql`now()` })
        .where(and(eq(users.id, flipped.userId), ne(users.recruiterVerificationTier, "elevated")));
    }

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId: reviewerUserId,
      targetUserId: flipped.userId,
      eventType:
        decision === "approve"
          ? "recruiter_verification.approved"
          : "recruiter_verification.rejected",
      reason: cleanReason,
      // resubmissionCount tells a later reader whether this verdict landed on a first application
      // or on a reopened one, and how many attempts preceded it.
      metadata: {
        submissionId,
        resubmissionCount: flipped.resubmissionCount,
        ...(decision === "reject" ? { resubmissionAllowed: allowResubmission } : {}),
      },
    });

    return { submissionId, userId: flipped.userId, status: targetStatus };
  });

  logger.info("recruiter_verification.reviewed", {
    submissionId,
    reviewerUserId,
    decision,
  });

  // Dual-channel rejection notice (email + inbox), fire-and-forget: an enqueue failure must not
  // fail a review that already committed. Approval needs no notification — the recruiter's next
  // page load shows them Trusted.
  if (decision === "reject" && cleanReason) {
    try {
      await enqueueRecruiterVerificationRejected({
        submissionId,
        userId: result.userId,
        rejectionReason: cleanReason,
        resubmissionAllowed: allowResubmission,
        epoch: Date.now(),
      });
    } catch (error) {
      logger.warn("recruiter_verification.rejection_notice_enqueue_failed", {
        submissionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Post-review sweep, best-effort and post-commit — it never affects the review outcome.
  // Approval is terminal: the submission can never accept another upload, so every unreferenced
  // object is a definite orphan and the age guard is unnecessary. A rejected submission stays
  // editable while the recruiter revises it, so the age guard must hold or a sweep racing an
  // upload the recruiter started seconds earlier in another tab would delete it mid-flight.
  const isTerminal = decision === "approve";
  await sweepOrphanedSubmissionObjects(
    result.userId,
    submissionId,
    { respectAge: !isTerminal },
    db,
  );

  return result;
};
