import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/recruiter-verification/recruiter-verification-service");

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
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

// Standalone submission path for the recruiter dashboard (first submission after an OAuth
// signup, or re-submission after a rejection). Refuses when the account is already Trusted and
// surfaces a 409 when an open submission already exists.
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

// Returns the account's single open submission id, or null when it has none. Documents can only be
// attached to a submission that is still awaiting review — never to reviewed history rows.
export const findPendingSubmissionIdForUser = async (
  userId: string,
  db: Database = getDb(),
): Promise<string | null> => {
  const [pending] = await db
    .select({ id: recruiterVerificationSubmissions.id })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        eq(recruiterVerificationSubmissions.status, "pending_review"),
      ),
    )
    .limit(1);

  return pending?.id ?? null;
};

// Resolves the caller's single open submission id, or 404s.
const requirePendingSubmissionId = async (userId: string, db: Database): Promise<string> => {
  const pendingId = await findPendingSubmissionIdForUser(userId, db);
  if (!pendingId) {
    throw new RecruiterVerificationError(
      "recruiter_verification_not_found",
      "No verification submission is awaiting review for this account",
    );
  }
  return pendingId;
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

// Account-level entry point for the sweep: reclaims orphaned upload objects for an account's open
// submission, if it has one. Used by the platform-ops manual tier-elevation path, which turns an
// account Trusted without going through the review flow's terminal sweep. No-op when the account
// has no pending submission or storage is unconfigured; never throws.
export const sweepOrphanedObjectsForAccount = async (
  userId: string,
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;
  try {
    const submissionId = await findPendingSubmissionIdForUser(userId, db);
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

  const pendingId = await requirePendingSubmissionId(userId, db);

  // Reclaim any object left behind by an earlier abandoned or replaced upload before minting a new
  // one, so orphans do not accumulate across attempts.
  await sweepOrphanedSubmissionObjects(userId, pendingId, { respectAge: true }, db);

  const r2Key = `recruiter-verification/${userId}/${pendingId}/${crypto.randomUUID()}`;
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

  const pendingId = await requirePendingSubmissionId(userId, db);
  const expectedPrefix = `recruiter-verification/${userId}/${pendingId}/`;
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
      submissionId: pendingId,
      r2Key: input.r2Key,
      originalFileName: sanitizeFileName(input.originalFileName),
      fileSizeBytes: head.sizeBytes,
      contentType: detected,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");

  // Reclaim any prior un-finalized upload for this submission now that a valid document exists.
  await sweepOrphanedSubmissionObjects(userId, pendingId, { respectAge: true }, db);

  return row;
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
// vouched. Returns true when a row was marked. Never throws domain errors — the caller treats
// this as a fire-and-forget priority bump.
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
        eq(recruiterVerificationSubmissions.status, "pending_review"),
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

// Review queue for platform ops, priority-ordered: vouched submissions first, then corporate
// email domain, then documents attached, then oldest first. Priority reorders the queue only —
// approval is always a human decision. Each entry carries its attached documents so the reviewer
// can view or download the affiliation proof inline.
export const listPendingRecruiterVerifications = async (
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
    .where(eq(recruiterVerificationSubmissions.status, "pending_review"))
    .orderBy(
      sql`(${recruiterVerificationSubmissions.vouchedAt} is not null) desc`,
      sql`(${recruiterVerificationSubmissions.emailDomainFlag} is true) desc`,
      sql`${hasDocuments} desc`,
      recruiterVerificationSubmissions.submittedAt,
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

export type RecruiterVerificationReviewResult = {
  submissionId: string;
  userId: string;
  status: "approved" | "rejected";
};

// Platform-ops review decision. One transaction: CAS status flip (only from pending_review),
// tier elevation on approval, and the platform_ops audit row. Rejection requires a reason,
// stored on the submission and shown to the recruiter for re-submission.
export const reviewRecruiterVerification = async (
  reviewerUserId: string,
  submissionId: string,
  decision: "approve" | "reject",
  rejectionReason: string | null,
  db: Database = getDb(),
): Promise<RecruiterVerificationReviewResult> => {
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
      })
      .where(
        and(
          eq(recruiterVerificationSubmissions.id, submissionId),
          eq(recruiterVerificationSubmissions.status, "pending_review"),
        ),
      )
      .returning({ userId: recruiterVerificationSubmissions.userId });

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
      metadata: { submissionId },
    });

    return { submissionId, userId: flipped.userId, status: targetStatus };
  });

  logger.info("recruiter_verification.reviewed", {
    submissionId,
    reviewerUserId,
    decision,
  });

  // Terminal sweep: the submission has left the pending queue, so no further upload can arrive and
  // any object not referenced by a document row is a definite orphan. Best-effort and post-commit —
  // it never affects the review outcome.
  await sweepOrphanedSubmissionObjects(result.userId, submissionId, { respectAge: false }, db);

  return result;
};
