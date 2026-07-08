import { and, asc, count, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  institutionMemberships,
  institutionVerificationAudit,
  institutionVerificationDocuments,
  institutionVerificationSubmissions,
  institutions,
  users,
  type InstitutionType,
  type VerificationSubmissionStatus,
} from "@/server/db/schema";
import {
  getRecruiterTierForAccount,
  meetsRecruiterTier,
  FULL_INSTITUTION_CREATION_MIN_TIER,
  RecruiterTierError,
} from "@/server/auth/recruiter-tier";
import { MAX_INSTITUTIONS_PER_RECRUITER } from "@/server/institution-workspace/institution-core";
import { acquireOwnerCapLock } from "@/server/institution-workspace/owner-cap-lock";
import {
  assertInstitutionTypeTransition,
  isFullInstitutionType,
  type FullInstitutionType,
} from "@/server/institution-workspace/institution-type";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";
import { isR2Available, generatePresignedPutUrl } from "@/server/storage/r2.client";
import { logger } from "@/lib/logger";
import {
  deriveEmailDomainFlag,
  getMissingDocuments,
} from "./verification-requirements";
import {
  sendInstitutionVerifiedEmail,
} from "./verification-email";

assertServerOnly("server/institution-verification/submission-service");

const OWNER_ROLE = "institution_owner";
const ACTIVE_MEMBERSHIP = "active";
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

export class SubmissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export type DocumentInput = {
  documentType: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

export type SubmissionWithUploadUrls = {
  submissionId: string;
  documents: Array<{
    documentType: string;
    r2Key: string;
    uploadUrl: string;
  }>;
};

export type SubmissionListItem = {
  id: string;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: VerificationSubmissionStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewerNotes: string | null;
  documentCount: number;
};

export type DocumentRecord = {
  id: string;
  documentType: string;
  r2Key: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

export type SubmissionDetail = {
  id: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  submittedByUserId: string | null;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: VerificationSubmissionStatus;
  emailDomainFlag: boolean | null;
  reviewerUserId: string | null;
  reviewerNotes: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  documents: DocumentRecord[];
};

export type PendingSubmissionListItem = {
  id: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  submitterEmail: string | null;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  emailDomainFlag: boolean | null;
  submittedAt: Date;
  documentCount: number;
};

// Resolves the institution_id and verifies the actor holds an active institution_owner membership.
const resolveOwnerInstitution = async (
  institutionSlug: string,
  actorUserId: string,
  db: Database,
): Promise<{ institutionId: string; institutionType: InstitutionType | null }> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionType: institutions.institutionType,
      membershipId: institutionMemberships.id,
    })
    .from(institutions)
    .innerJoin(
      institutionMemberships,
      and(
        eq(institutionMemberships.institutionId, institutions.id),
        eq(institutionMemberships.userId, actorUserId),
        eq(institutionMemberships.membershipRole, OWNER_ROLE),
        eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
      ),
    )
    .where(eq(institutions.slug, institutionSlug))
    .limit(1);

  if (!row) {
    throw new SubmissionError(
      "institution_not_found",
      404,
      "Institution not found or you do not have owner access",
    );
  }

  return { institutionId: row.institutionId, institutionType: row.institutionType ?? null };
};

// Submits a verification request for an institution. Validates target type, documents, and tier.
// Returns presigned PUT URLs for each document so the client can upload directly to R2.
export const createVerificationSubmission = async (
  institutionSlug: string,
  targetType: InstitutionType,
  proposedDisplayName: string | null,
  documents: DocumentInput[],
  actorUserId: string,
  db: Database = getDb(),
): Promise<SubmissionWithUploadUrls> => {
  if (!isR2Available()) {
    throw new SubmissionError(
      "verification_storage_unavailable",
      503,
      "Document storage is unavailable",
    );
  }

  const { institutionId, institutionType: currentType } =
    await resolveOwnerInstitution(institutionSlug, actorUserId, db);

  // Validate the target type transition using the existing state machine guard.
  assertInstitutionTypeTransition(currentType, targetType);

  // Upgrade path: personal → full type requires elevated tier and a proposed display name.
  const isUpgrade = currentType === "personal" && targetType !== "personal";
  if (isUpgrade || currentType === null) {
    // NULL → full type (legacy first-declaration) also requires elevated tier.
    const tierState = await getRecruiterTierForAccount(actorUserId, db);
    if (
      !tierState ||
      !tierState.recruiterVerified ||
      !meetsRecruiterTier(tierState.recruiterVerificationTier, FULL_INSTITUTION_CREATION_MIN_TIER)
    ) {
      throw new RecruiterTierError(
        "recruiter_tier_insufficient",
        403,
        `Submitting verification for a full institution type requires '${FULL_INSTITUTION_CREATION_MIN_TIER}' tier`,
        { requiredTier: FULL_INSTITUTION_CREATION_MIN_TIER },
      );
    }
  }

  if (isUpgrade) {
    if (!proposedDisplayName || proposedDisplayName.trim().length === 0) {
      throw new SubmissionError(
        "proposed_display_name_required",
        422,
        "A display name is required when upgrading from personal to a full institution type",
      );
    }
  }

  // Validate all required documents are present.
  const submittedTypes = documents.map((d) => d.documentType);
  const missingDocs = getMissingDocuments(targetType, submittedTypes);
  if (missingDocs.length > 0) {
    throw new SubmissionError(
      "missing_required_documents",
      422,
      `Missing required documents: ${missingDocs.join(", ")}`,
      { missingDocuments: missingDocs },
    );
  }

  // Derive email domain flag for university/campus_organization submissions.
  let emailDomainFlag: boolean | null = null;
  if (targetType === "university" || targetType === "campus_organization") {
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    if (userRow) {
      emailDomainFlag = deriveEmailDomainFlag(targetType, userRow.email);
    }
  }

  // Insert submission row first so we have the submissionId for R2 keys.
  const [submissionRow] = await db
    .insert(institutionVerificationSubmissions)
    .values({
      institutionId,
      submittedByUserId: actorUserId,
      targetInstitutionType: targetType,
      proposedDisplayName: proposedDisplayName?.trim() ?? null,
      emailDomainFlag,
    })
    .returning({ id: institutionVerificationSubmissions.id });

  if (!submissionRow) {
    throw new Error("Failed to create verification submission");
  }

  const submissionId = submissionRow.id;

  // Generate R2 keys and presigned PUT URLs for each document, then insert document rows.
  const documentResults: SubmissionWithUploadUrls["documents"] = [];

  for (const doc of documents) {
    const r2Key = `verification/${institutionId}/${submissionId}/${doc.documentType}`;
    const uploadUrl = await generatePresignedPutUrl(r2Key, doc.contentType, PRESIGNED_URL_EXPIRY_SECONDS);

    await db.insert(institutionVerificationDocuments).values({
      submissionId,
      documentType: doc.documentType,
      r2Key,
      originalFileName: doc.originalFileName,
      fileSizeBytes: doc.fileSizeBytes,
      contentType: doc.contentType,
    });

    documentResults.push({ documentType: doc.documentType, r2Key, uploadUrl });
  }

  logger.info("institution.verification.submission.created", {
    submissionId,
    institutionId,
    targetType,
    actorUserId,
  });

  return { submissionId, documents: documentResults };
};

// Returns the submission history for an institution (owner-scoped).
export const listInstitutionVerificationSubmissions = async (
  institutionSlug: string,
  actorUserId: string,
  db: Database = getDb(),
): Promise<SubmissionListItem[]> => {
  const { institutionId } = await resolveOwnerInstitution(institutionSlug, actorUserId, db);

  const rows = await db
    .select({
      id: institutionVerificationSubmissions.id,
      targetInstitutionType: institutionVerificationSubmissions.targetInstitutionType,
      proposedDisplayName: institutionVerificationSubmissions.proposedDisplayName,
      status: institutionVerificationSubmissions.status,
      submittedAt: institutionVerificationSubmissions.submittedAt,
      reviewedAt: institutionVerificationSubmissions.reviewedAt,
      reviewerNotes: institutionVerificationSubmissions.reviewerNotes,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM institution_verification_documents ivd
        WHERE ivd.submission_id = institution_verification_submissions.id
      )`,
    })
    .from(institutionVerificationSubmissions)
    .where(eq(institutionVerificationSubmissions.institutionId, institutionId))
    .orderBy(desc(institutionVerificationSubmissions.submittedAt));

  return rows;
};

// Returns full detail for a submission. Accessible by the institution owner OR platform_ops.
export const getVerificationSubmissionDetail = async (
  submissionId: string,
  actorUserId: string,
  actorRole: string,
  db: Database = getDb(),
): Promise<SubmissionDetail> => {
  const [sub] = await db
    .select({
      id: institutionVerificationSubmissions.id,
      institutionId: institutionVerificationSubmissions.institutionId,
      institutionSlug: institutions.slug,
      institutionDisplayName: institutions.displayName,
      institutionType: institutions.institutionType,
      ownerUsername: sql<string | null>`(
        SELECT u.username FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC LIMIT 1
      )`,
      submittedByUserId: institutionVerificationSubmissions.submittedByUserId,
      targetInstitutionType: institutionVerificationSubmissions.targetInstitutionType,
      proposedDisplayName: institutionVerificationSubmissions.proposedDisplayName,
      status: institutionVerificationSubmissions.status,
      emailDomainFlag: institutionVerificationSubmissions.emailDomainFlag,
      reviewerUserId: institutionVerificationSubmissions.reviewerUserId,
      reviewerNotes: institutionVerificationSubmissions.reviewerNotes,
      submittedAt: institutionVerificationSubmissions.submittedAt,
      reviewedAt: institutionVerificationSubmissions.reviewedAt,
    })
    .from(institutionVerificationSubmissions)
    .innerJoin(institutions, eq(institutions.id, institutionVerificationSubmissions.institutionId))
    .where(eq(institutionVerificationSubmissions.id, submissionId))
    .limit(1);

  if (!sub) {
    throw new SubmissionError("submission_not_found", 404, "Submission not found");
  }

  // Access control: platform_ops or the institution owner.
  if (actorRole !== "platform_ops") {
    const [membership] = await db
      .select({ id: institutionMemberships.id })
      .from(institutionMemberships)
      .where(
        and(
          eq(institutionMemberships.institutionId, sub.institutionId),
          eq(institutionMemberships.userId, actorUserId),
          eq(institutionMemberships.membershipRole, OWNER_ROLE),
          eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
        ),
      )
      .limit(1);

    if (!membership) {
      throw new AccessError("forbidden", 403, "Access denied");
    }
  }

  const documents = await db
    .select({
      id: institutionVerificationDocuments.id,
      documentType: institutionVerificationDocuments.documentType,
      r2Key: institutionVerificationDocuments.r2Key,
      originalFileName: institutionVerificationDocuments.originalFileName,
      fileSizeBytes: institutionVerificationDocuments.fileSizeBytes,
      contentType: institutionVerificationDocuments.contentType,
    })
    .from(institutionVerificationDocuments)
    .where(eq(institutionVerificationDocuments.submissionId, submissionId))
    .orderBy(asc(institutionVerificationDocuments.createdAt));

  return {
    id: sub.id,
    institutionId: sub.institutionId,
    institutionSlug: sub.institutionSlug,
    institutionDisplayName: getInstitutionDisplayName(
      { displayName: sub.institutionDisplayName, institutionType: sub.institutionType ?? null },
      { username: sub.ownerUsername },
    ),
    submittedByUserId: sub.submittedByUserId,
    targetInstitutionType: sub.targetInstitutionType,
    proposedDisplayName: sub.proposedDisplayName,
    status: sub.status,
    emailDomainFlag: sub.emailDomainFlag,
    reviewerUserId: sub.reviewerUserId,
    reviewerNotes: sub.reviewerNotes,
    submittedAt: sub.submittedAt,
    reviewedAt: sub.reviewedAt,
    documents,
  };
};

// Platform ops: list all pending_review submissions.
export const listPendingVerificationSubmissions = async (
  actorRole: string,
  db: Database = getDb(),
): Promise<PendingSubmissionListItem[]> => {
  if (actorRole !== "platform_ops") {
    throw new AccessError("forbidden", 403, "platform_ops access required");
  }

  const rows = await db
    .select({
      id: institutionVerificationSubmissions.id,
      institutionId: institutions.id,
      institutionSlug: institutions.slug,
      institutionDisplayName: institutions.displayName,
      institutionType: institutions.institutionType,
      ownerUsername: sql<string | null>`(
        SELECT u.username FROM institution_memberships im
        INNER JOIN users u ON u.id = im.user_id
        WHERE im.institution_id = institutions.id
          AND im.membership_role = 'institution_owner'
          AND im.status = 'active'
        ORDER BY im.created_at ASC LIMIT 1
      )`,
      submitterEmail: sql<string | null>`(
        SELECT u.email FROM users u
        WHERE u.id = institution_verification_submissions.submitted_by_user_id
        LIMIT 1
      )`,
      targetInstitutionType: institutionVerificationSubmissions.targetInstitutionType,
      proposedDisplayName: institutionVerificationSubmissions.proposedDisplayName,
      emailDomainFlag: institutionVerificationSubmissions.emailDomainFlag,
      submittedAt: institutionVerificationSubmissions.submittedAt,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM institution_verification_documents ivd
        WHERE ivd.submission_id = institution_verification_submissions.id
      )`,
    })
    .from(institutionVerificationSubmissions)
    .innerJoin(institutions, eq(institutions.id, institutionVerificationSubmissions.institutionId))
    .where(eq(institutionVerificationSubmissions.status, "pending_review"))
    .orderBy(asc(institutionVerificationSubmissions.submittedAt));

  return rows.map((r) => ({
    ...r,
    institutionDisplayName: getInstitutionDisplayName(
      { displayName: r.institutionDisplayName, institutionType: r.institutionType ?? null },
      { username: r.ownerUsername },
    ),
  }));
};

// Platform ops: approve or reject a submission.
// On approval of a regular verification: transitions verification_status to verified.
// On approval of an upgrade (personal → full): upgrades type, persists display_name, then verifies.
// All writes are atomic in one transaction (closes 6.5f.1-S1).
export const reviewVerificationSubmission = async (
  submissionId: string,
  decision: "approved" | "rejected",
  reviewerNotes: string | null,
  reviewerUserId: string,
  actorRole: string,
  db: Database = getDb(),
): Promise<{ submissionId: string; status: VerificationSubmissionStatus }> => {
  if (actorRole !== "platform_ops") {
    throw new AccessError("forbidden", 403, "platform_ops access required");
  }

  return db.transaction(async (tx) => {
    // CAS guard: only pending_review submissions can be reviewed.
    const [sub] = await tx
      .select({
        id: institutionVerificationSubmissions.id,
        institutionId: institutionVerificationSubmissions.institutionId,
        targetInstitutionType: institutionVerificationSubmissions.targetInstitutionType,
        proposedDisplayName: institutionVerificationSubmissions.proposedDisplayName,
        status: institutionVerificationSubmissions.status,
        submittedByUserId: institutionVerificationSubmissions.submittedByUserId,
      })
      .from(institutionVerificationSubmissions)
      .where(eq(institutionVerificationSubmissions.id, submissionId))
      .limit(1);

    if (!sub) {
      throw new SubmissionError("submission_not_found", 404, "Submission not found");
    }
    if (sub.status !== "pending_review") {
      throw new SubmissionError(
        "submission_already_reviewed",
        409,
        `Submission is already '${sub.status}' and cannot be reviewed again`,
      );
    }

    // Fetch current institution state for the approval path.
    const [inst] = await tx
      .select({
        id: institutions.id,
        displayName: institutions.displayName,
        institutionType: institutions.institutionType,
        verificationStatus: institutions.verificationStatus,
        slug: institutions.slug,
      })
      .from(institutions)
      .where(eq(institutions.id, sub.institutionId))
      .limit(1);

    if (!inst) {
      throw new SubmissionError("institution_not_found", 404, "Institution not found");
    }

    const now = new Date();

    if (decision === "rejected") {
      await tx
        .update(institutionVerificationSubmissions)
        .set({ status: "rejected", reviewerUserId, reviewerNotes, reviewedAt: now })
        .where(eq(institutionVerificationSubmissions.id, submissionId));

      // Audit every review decision — rejections are moderation actions just as approvals are.
      await tx.insert(institutionVerificationAudit).values({
        institutionId: sub.institutionId,
        actorUserId: reviewerUserId,
        fromStatus: inst.verificationStatus,
        toStatus: inst.verificationStatus,
        reason: reviewerNotes ?? null,
      });

      logger.info("institution.verification.submission.rejected", {
        submissionId,
        institutionId: sub.institutionId,
        reviewerUserId,
      });

      return { submissionId, status: "rejected" };
    }

    // Approval path.
    const currentType = inst.institutionType ?? null;
    const targetType = sub.targetInstitutionType;
    const isUpgrade = currentType === "personal" && isFullInstitutionType(targetType);
    const isLegacyDeclaration = currentType === null && isFullInstitutionType(targetType);

    if (isUpgrade || isLegacyDeclaration) {
      // Fail-closed: if the submitter's account has been deleted (ON DELETE SET NULL),
      // the tier gate can no longer be verified — block the upgrade approval.
      if (!sub.submittedByUserId) {
        throw new SubmissionError(
          "submitter_account_deleted",
          409,
          "The submitter's account has been deleted; upgrade approval requires tier verification",
        );
      }

      // Tier check uses the outer db — the tier is a read-only gate that does not need to
      // be fenced inside the write transaction.
      const tierState = await getRecruiterTierForAccount(sub.submittedByUserId, db);
      if (
        !tierState ||
        !tierState.recruiterVerified ||
        !meetsRecruiterTier(tierState.recruiterVerificationTier, FULL_INSTITUTION_CREATION_MIN_TIER)
      ) {
        throw new RecruiterTierError(
          "recruiter_tier_insufficient",
          403,
          "The submitter no longer meets the tier requirement for this upgrade",
          { requiredTier: FULL_INSTITUTION_CREATION_MIN_TIER },
        );
      }

      // Full-institution limit re-check inside the transaction: count existing full institutions
      // owned by the current active owner of this institution, excluding the upgrading institution
      // itself (which is currently personal and not yet counted as full). After upgrade there would
      // be existingFullCount + 1 full institutions.
      const [ownerRow] = await tx
        .select({ userId: institutionMemberships.userId })
        .from(institutionMemberships)
        .where(
          and(
            eq(institutionMemberships.institutionId, sub.institutionId),
            eq(institutionMemberships.membershipRole, OWNER_ROLE),
            eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
          ),
        )
        .limit(1);

      if (!ownerRow) {
        throw new SubmissionError(
          "institution_owner_not_found",
          409,
          "No active institution_owner found for this institution; cannot verify limit",
        );
      }

      // Serialize concurrent same-owner upgrade approvals before counting the owner's full
      // institutions. The count below ranges over the owner's OTHER institution rows, so gating the
      // UPDATE on the target row alone cannot fence it — two approvals of two different institutions
      // for the same owner each snapshot a count blind to the other's uncommitted type-flip and both
      // pass the cap. The lock keyed on ownerRow.userId makes the count-then-flip atomic per owner.
      // See acquireOwnerCapLock.
      await acquireOwnerCapLock(tx, ownerRow.userId);

      const [limitRow] = await tx
        .select({ value: count() })
        .from(institutionMemberships)
        .innerJoin(institutions, eq(institutions.id, institutionMemberships.institutionId))
        .where(
          and(
            eq(institutionMemberships.userId, ownerRow.userId),
            eq(institutionMemberships.membershipRole, OWNER_ROLE),
            eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
            or(isNull(institutions.institutionType), ne(institutions.institutionType, "personal")),
            ne(institutions.id, sub.institutionId),
          ),
        );

      const existingFullCount = limitRow?.value ?? 0;
      if (existingFullCount + 1 > MAX_INSTITUTIONS_PER_RECRUITER) {
        throw new SubmissionError(
          "institution_upgrade_limit_reached",
          409,
          `Approving this upgrade would exceed the limit of ${MAX_INSTITUTIONS_PER_RECRUITER} full institutions for this recruiter`,
        );
      }

      // Validate the proposed display name for upgrade.
      if (isUpgrade) {
        if (!sub.proposedDisplayName || sub.proposedDisplayName.trim().length === 0) {
          throw new SubmissionError(
            "proposed_display_name_required",
            422,
            "Upgrade approval requires a proposed display name",
          );
        }
      }

      // Atomic: flip type + persist display_name + transition verification_status.
      // This closes 6.5f.1-S1: display_name is written before the transaction commits;
      // the institutions_display_name_type_chk CHECK constraint enforces this at DB level.
      const displayNameToSet =
        isUpgrade ? sub.proposedDisplayName!.trim() : inst.displayName ?? sub.proposedDisplayName?.trim() ?? null;

      await tx
        .update(institutions)
        .set({
          institutionType: isFullInstitutionType(targetType) ? (targetType as FullInstitutionType) : inst.institutionType,
          displayName: displayNameToSet,
          verificationStatus: "verified",
          verifiedAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(institutions.id, sub.institutionId));
    } else {
      // Regular verification: same type (or same-type personal KTP verification).
      // Just transition verification_status to verified.
      await tx
        .update(institutions)
        .set({ verificationStatus: "verified", verifiedAt: now, updatedAt: sql`now()` })
        .where(eq(institutions.id, sub.institutionId));
    }

    // Write audit entry (mirrors verifyInstitution from verification-service.ts).
    await tx.insert(institutionVerificationAudit).values({
      institutionId: sub.institutionId,
      actorUserId: reviewerUserId,
      fromStatus: inst.verificationStatus,
      toStatus: "verified",
      reason: reviewerNotes ?? null,
    });

    // Mark submission approved.
    await tx
      .update(institutionVerificationSubmissions)
      .set({ status: "approved", reviewerUserId, reviewerNotes, reviewedAt: now })
      .where(eq(institutionVerificationSubmissions.id, submissionId));

    logger.info("institution.verification.submission.approved", {
      submissionId,
      institutionId: sub.institutionId,
      targetType,
      isUpgrade,
      reviewerUserId,
    });

    // Post-commit email (non-blocking, best-effort).
    const ownersEmailPromise = (async () => {
      const [ownerRow] = await db
        .select({ email: users.email, username: users.username })
        .from(institutionMemberships)
        .innerJoin(users, eq(users.id, institutionMemberships.userId))
        .where(
          and(
            eq(institutionMemberships.institutionId, sub.institutionId),
            eq(institutionMemberships.membershipRole, OWNER_ROLE),
            eq(institutionMemberships.status, ACTIVE_MEMBERSHIP),
          ),
        )
        .orderBy(asc(institutionMemberships.createdAt))
        .limit(1);

      if (ownerRow) {
        const resolvedName = getInstitutionDisplayName(
          {
            displayName: isUpgrade ? sub.proposedDisplayName : inst.displayName,
            institutionType: isUpgrade ? (targetType as FullInstitutionType) : inst.institutionType ?? null,
          },
          { username: ownerRow.username },
        );
        await sendInstitutionVerifiedEmail({
          toEmail: ownerRow.email,
          institutionDisplayName: resolvedName,
        });
      }
    })();

    ownersEmailPromise.catch((err: unknown) => {
      logger.error("institution.verification.submission.email_failed", {
        submissionId,
        institutionId: sub.institutionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { submissionId, status: "approved" };
  });
};
