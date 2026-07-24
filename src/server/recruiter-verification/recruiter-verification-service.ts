import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/recruiter-verification/recruiter-verification-service");

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
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
import { generatePresignedPutUrl, isR2Available } from "@/server/storage/r2.client";

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

const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

export type AttachedDocumentWithUploadUrl = {
  document: RecruiterVerificationDocumentRecord;
  uploadUrl: string;
};

// Attaches an affiliation-proof document to the caller's open submission and returns a presigned
// PUT URL for the direct-to-R2 upload (same flow as institution verification documents). 404
// when no open submission exists — documents cannot be attached to reviewed history rows.
export const attachDocumentToPendingSubmission = async (
  userId: string,
  file: { originalFileName: string; fileSizeBytes: number; contentType: string },
  db: Database = getDb(),
): Promise<AttachedDocumentWithUploadUrl> => {
  if (!isR2Available()) {
    throw new RecruiterVerificationError(
      "recruiter_verification_storage_unavailable",
      "Document storage is unavailable",
    );
  }

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

  if (!pending) {
    throw new RecruiterVerificationError(
      "recruiter_verification_not_found",
      "No verification submission is awaiting review for this account",
    );
  }

  const r2Key = `recruiter-verification/${userId}/${pending.id}/${crypto.randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    r2Key,
    file.contentType,
    PRESIGNED_URL_EXPIRY_SECONDS,
  );

  const [row] = await db
    .insert(recruiterVerificationDocuments)
    .values({ submissionId: pending.id, r2Key, ...file })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return { document: row, uploadUrl };
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

export type PendingRecruiterVerificationEntry = {
  submission: RecruiterVerificationSubmissionRecord;
  submitter: { email: string | null; username: string | null; name: string | null };
  hasDocuments: boolean;
};

// Review queue for platform ops, priority-ordered: vouched submissions first, then corporate
// email domain, then documents attached, then oldest first. Priority reorders the queue only —
// approval is always a human decision.
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

  return rows.map((row) => ({
    submission: row.submission,
    submitter: { email: row.email, username: row.username, name: row.name },
    hasDocuments: row.hasDocuments,
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

  return result;
};
