import { and, asc, desc, eq, sql } from "drizzle-orm";
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
  type InstitutionVerificationStatus,
  type VerificationSubmissionStatus,
} from "@/server/db/schema";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { assertValidTransition } from "@/server/institution-verification/verification-core";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";
import { isR2Available, generatePresignedPutUrl } from "@/server/storage/r2.client";
import { logger } from "@/lib/logger";
import { deriveEmailDomainFlag, getMissingDocuments } from "./verification-requirements";
import { sendInstitutionVerifiedEmail } from "./verification-email";

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

// Serializes the open-submission guard of a single institution for the life of `tx`.
//
// Why this exists: "at most one submission awaiting review" is a cross-row predicate, not a state
// transition on an existing row — the contended row does not exist yet, so there is nothing to
// compare-and-set against. Under READ COMMITTED two concurrent submissions (a double-clicked submit
// button is the realistic case) each take a snapshot that cannot see the other's uncommitted insert,
// both pass the guard, and the ops queue gains a duplicate. A transaction-scoped advisory lock keyed
// on the institution is the serialization point, matching the per-owner cap lock convention in
// `institution-workspace/owner-cap-lock.ts` (DEC-0099).
//
// Keyed per institution, so one institution's submission never blocks another's. Transaction-scoped
// and therefore safe under Neon's PgBouncer transaction-mode pooling; do not switch to the
// session-scoped variant.
const acquireInstitutionSubmissionLock = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  institutionId: string,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`inst_verif_submit:${institutionId}`}))`,
  );
};

// Resolves the institution_id and verifies the actor holds an active institution_owner membership.
const resolveOwnerInstitution = async (
  institutionSlug: string,
  actorUserId: string,
  db: Database,
): Promise<{
  institutionId: string;
  institutionType: InstitutionType;
  verificationStatus: InstitutionVerificationStatus;
}> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionType: institutions.institutionType,
      verificationStatus: institutions.verificationStatus,
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

  return {
    institutionId: row.institutionId,
    institutionType: row.institutionType,
    verificationStatus: row.verificationStatus,
  };
};

// Submits a document verification request for a full institution. Verification is credibility-only:
// it does not gate publishing (that gates on the account-level Trusted Recruiter status), it does
// not change an institution's reach, and it never changes an institution's type — the type is fixed
// at creation. The required documents are those of the institution's own type. Returns presigned PUT
// URLs so the client can upload directly to R2.
//
// A submission is accepted only while there is something left to decide. An institution already
// carrying verification_status = 'verified' has its answer, and one with a submission still awaiting
// review has a reviewer holding its evidence — in both cases another request adds a queue row nobody
// can act on. Both refusals are server-side because the page hiding the form is a courtesy, not a
// guard.
export const createVerificationSubmission = async (
  institutionSlug: string,
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

  const { institutionId, institutionType, verificationStatus } = await resolveOwnerInstitution(
    institutionSlug,
    actorUserId,
    db,
  );

  // A personal institution is the person, and the person is verified through the account-level
  // Trusted Recruiter review — there is nothing separate to document here. Reaching a full type is
  // the self-service upgrade, not a document submission.
  if (isPersonalInstitutionType(institutionType)) {
    throw new SubmissionError(
      "institution_verification_not_applicable",
      409,
      "A personal institution has no document verification. Upgrade it to a full institution type first",
    );
  }

  // Checked against the institution's own column rather than against an approved submission row,
  // because platform_ops can also verify an institution directly from the admin table
  // (`verifyInstitution`), which writes this column and creates no submission at all.
  if (verificationStatus === "verified") {
    throw new SubmissionError(
      "institution_already_verified",
      409,
      "This institution is already verified and cannot submit further documents",
    );
  }

  // Validate all required documents are present.
  const submittedTypes = documents.map((d) => d.documentType);
  const missingDocs = getMissingDocuments(institutionType, submittedTypes);
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
  if (institutionType === "university" || institutionType === "campus_organization") {
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    if (userRow) {
      emailDomainFlag = deriveEmailDomainFlag(institutionType, userRow.email);
    }
  }

  // The open-submission guard and the insert it protects share one transaction under the
  // per-institution lock, so two simultaneous submissions cannot both find the queue empty. The
  // document rows join them: a failure part-way through now rolls the submission back rather than
  // leaving a queue row whose evidence is incomplete.
  const { submissionId, documentResults } = await db.transaction(async (tx) => {
    await acquireInstitutionSubmissionLock(tx, institutionId);

    const [openSubmission] = await tx
      .select({ id: institutionVerificationSubmissions.id })
      .from(institutionVerificationSubmissions)
      .where(
        and(
          eq(institutionVerificationSubmissions.institutionId, institutionId),
          eq(institutionVerificationSubmissions.status, "pending_review"),
        ),
      )
      .limit(1);

    if (openSubmission) {
      throw new SubmissionError(
        "verification_submission_already_pending",
        409,
        "A verification submission for this institution is already awaiting review",
      );
    }

    // Insert submission row first so we have the submissionId for R2 keys.
    const [submissionRow] = await tx
      .insert(institutionVerificationSubmissions)
      .values({
        institutionId,
        submittedByUserId: actorUserId,
        targetInstitutionType: institutionType,
        emailDomainFlag,
      })
      .returning({ id: institutionVerificationSubmissions.id });

    if (!submissionRow) {
      throw new Error("Failed to create verification submission");
    }

    const createdSubmissionId = submissionRow.id;

    // Generate R2 keys and presigned PUT URLs for each document, then insert document rows.
    const createdDocuments: SubmissionWithUploadUrls["documents"] = [];

    for (const doc of documents) {
      const r2Key = `verification/${institutionId}/${createdSubmissionId}/${doc.documentType}`;
      const uploadUrl = await generatePresignedPutUrl(
        r2Key,
        doc.contentType,
        PRESIGNED_URL_EXPIRY_SECONDS,
      );

      await tx.insert(institutionVerificationDocuments).values({
        submissionId: createdSubmissionId,
        documentType: doc.documentType,
        r2Key,
        originalFileName: doc.originalFileName,
        fileSizeBytes: doc.fileSizeBytes,
        contentType: doc.contentType,
      });

      createdDocuments.push({ documentType: doc.documentType, r2Key, uploadUrl });
    }

    return { submissionId: createdSubmissionId, documentResults: createdDocuments };
  });

  logger.info("institution.verification.submission.created", {
    submissionId,
    institutionId,
    institutionType,
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

    // Approval path. Verification confirms an institution's documents; it never changes the
    // institution's type (fixed at creation) or its reach. It only transitions verification_status.
    //
    // Held to the same rulebook as the admin table's own transitions, so the two paths cannot
    // disagree about what is legal. This matters now that no status is terminal: an approval racing
    // a revocation must be refused by whichever loses, not silently applied on top.
    assertValidTransition(inst.verificationStatus, "verified");

    const [verified] = await tx
      .update(institutions)
      .set({
        verificationStatus: "verified",
        verifiedAt: now,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(institutions.id, sub.institutionId),
          eq(institutions.verificationStatus, inst.verificationStatus),
        ),
      )
      .returning({ id: institutions.id });

    if (!verified) {
      throw new SubmissionError(
        "verification_transition_conflict",
        409,
        "This institution's verification status changed while you were reviewing. Reload and try again",
      );
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
        // Verification never renames an institution, so the stored display name is the current one.
        const resolvedName = getInstitutionDisplayName(
          {
            displayName: inst.displayName,
            institutionType: inst.institutionType ?? null,
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
