import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
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
import {
  assertValidTransition,
  VerificationError,
} from "@/server/institution-verification/verification-core";
import {
  hasPublishedPaidCompetition,
  readTickClosure,
  trustTickSubmitterInTransaction,
  type TickClosure,
} from "@/server/institution-verification/tick-service";
import {
  writeTickTransition,
  type TickPath,
} from "@/server/institution-verification/tick-transition";
import { resolvePlatformOpsActor } from "@/server/platform-ops/operator-actor";
import { assertOperatorHasNoInstitutionRelationship } from "@/server/institution-verification/operator-institution-conflict";
import { isR2Available, generatePresignedPutUrl } from "@/server/storage/r2.client";
import { logger } from "@/lib/logger";
import { deriveEmailDomainFlag, getMissingDocuments } from "./verification-requirements";
import { enqueueTickNoticeAfterCommit } from "./name-check-service";

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

const assertNoSubmissionAwaitingReview = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  institutionId: string,
): Promise<void> => {
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
  tickPath: TickPath | null;
}> => {
  const [row] = await db
    .select({
      institutionId: institutions.id,
      institutionType: institutions.institutionType,
      verificationStatus: institutions.verificationStatus,
      tickPath: institutions.tickPath,
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
    tickPath: row.tickPath,
  };
};

// A verified workspace has its answer, except one ticked by Path A: its name is the owner's own
// claim, so it may still send a request that proves the name.
const assertCanSubmitTickRequest = (
  verificationStatus: InstitutionVerificationStatus,
  tickPath: TickPath | null,
): void => {
  if (verificationStatus === "verified" && tickPath !== "domain") {
    throw new SubmissionError(
      "institution_already_verified",
      409,
      "This institution is already verified and cannot submit further documents",
    );
  }
};

// For university and campus_organization submissions only: whether the submitter's email is on an
// institutional domain. Null for every other kind.
const deriveSubmitterEmailDomainFlag = async (
  institutionType: InstitutionType,
  actorUserId: string,
  db: Database,
): Promise<boolean | null> => {
  if (institutionType !== "university" && institutionType !== "campus_organization") return null;

  const [userRow] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!userRow) return null;
  return deriveEmailDomainFlag(institutionType, userRow.email);
};

const buildTickClosedNeedsDocumentsError = (
  closure: Extract<TickClosure, { closed: true }>,
): SubmissionError =>
  new SubmissionError(
    "institution_tick_closed_needs_documents",
    409,
    "This workspace's tick was removed by staff or by a name proof rule, so it can only return through documents",
    { cause: closure.cause, closedInstitutionId: closure.closedInstitutionId },
  );

const buildNameProofNeedsDocumentsError = (): SubmissionError =>
  new SubmissionError(
    "institution_name_proof_needs_documents",
    409,
    "A name proof is running, so the name can only be proven through documents",
  );

const buildStatusChangedWhileReviewingError = (): SubmissionError =>
  new SubmissionError(
    "verification_transition_conflict",
    409,
    "This institution's verification status changed while you were reviewing. Reload and try again",
  );

// The refusals of a Path B request, in the order a submit and an approval both apply them: a closed
// workspace, a live paid competition on a workspace that is not ticked, a name proof that is
// running. Instagram proves neither a name nor a restart of payments, so each of them needs
// documents.
const assertInstagramRequestAllowed = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  institution: {
    institutionId: string;
    verificationStatus: InstitutionVerificationStatus;
    nameProofDueAt: Date | null;
  },
): Promise<void> => {
  const closure = await readTickClosure(tx, institution.institutionId);
  if (closure.closed) throw buildTickClosedNeedsDocumentsError(closure);

  if (
    institution.verificationStatus !== "verified" &&
    (await hasPublishedPaidCompetition(tx, institution.institutionId))
  ) {
    throw new SubmissionError(
      "institution_tick_live_paid_competition",
      409,
      "This workspace has a published paid competition, so its tick can only return through documents",
    );
  }

  if (institution.nameProofDueAt !== null) throw buildNameProofNeedsDocumentsError();
};

// After a Path B approval misses its compare-and-set, the workspace is read again to say why: a
// closure or a name proof that landed since the first read, or else the usual conflict.
const explainInstagramApprovalMiss = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  institutionId: string,
): Promise<SubmissionError> => {
  const closure = await readTickClosure(tx, institutionId);
  if (closure.closed) return buildTickClosedNeedsDocumentsError(closure);

  const [institution] = await tx
    .select({ nameProofDueAt: institutions.nameProofDueAt })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  if (institution?.nameProofDueAt) return buildNameProofNeedsDocumentsError();

  return buildStatusChangedWhileReviewingError();
};

// A path move on a Path A tick is pinned to that tick. A Path B move is also pinned to no running
// name proof, so a proof that commits after the approval's read survives it.
const buildPathMovePin = (requestedPath: TickPath): SQL => {
  const onDomainTick = eq(institutions.tickPath, "domain");
  if (requestedPath !== "instagram") return onDomainTick;
  return and(onDomainTick, isNull(institutions.nameProofDueAt))!;
};

const writeApprovedTick = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: {
    institutionId: string;
    fromStatus: InstitutionVerificationStatus;
    isPathMoveOnDomainTick: boolean;
    requestedPath: TickPath;
    actorUserId: string;
    reviewerNotes: string | null;
  },
): Promise<void> => {
  try {
    await writeTickTransition(tx, {
      institutionId: input.institutionId,
      from: input.fromStatus,
      to: "verified",
      tickPath: input.requestedPath,
      tickDomain: null,
      nameState: "cleared",
      actorUserId: input.actorUserId,
      reason: input.reviewerNotes ?? null,
      extraWhere: input.isPathMoveOnDomainTick ? buildPathMovePin(input.requestedPath) : undefined,
    });
  } catch (error) {
    const isConflict =
      error instanceof VerificationError && error.code === "verification_transition_conflict";
    if (!isConflict) throw error;

    if (input.requestedPath === "instagram") {
      throw await explainInstagramApprovalMiss(tx, input.institutionId);
    }
    throw buildStatusChangedWhileReviewingError();
  }
};

// Submits a document verification request for a full institution. Verification is credibility-only:
// it does not gate publishing (that gates on host trust), it does
// not change an institution's reach, and it never changes an institution's type — the type is fixed
// at creation. The required documents are those of the institution's own type. Returns presigned PUT
// URLs so the client can upload directly to R2.
//
// A submission is accepted only while there is something left to decide. An institution already
// carrying verification_status = 'verified' has its answer, and one with a submission still awaiting
// review has a reviewer holding its evidence — in both cases another request adds a queue row nobody
// can act on. Both refusals are server-side because the page hiding the form is a courtesy, not a
// guard. A workspace ticked by Path A is the one verified workspace that may still submit.
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

  const { institutionId, institutionType, verificationStatus, tickPath } =
    await resolveOwnerInstitution(institutionSlug, actorUserId, db);

  // A personal institution is the person, and the person is judged through host trust, so there is
  // nothing separate to document here.
  if (isPersonalInstitutionType(institutionType)) {
    throw new SubmissionError(
      "institution_verification_not_applicable",
      409,
      "A personal institution has no document verification yet",
    );
  }

  // Checked against the institution's own column rather than against an approved submission row,
  // because platform_ops can also verify an institution directly from the admin table
  // (`verifyInstitution`), which writes this column and creates no submission at all.
  assertCanSubmitTickRequest(verificationStatus, tickPath);

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

  const emailDomainFlag = await deriveSubmitterEmailDomainFlag(institutionType, actorUserId, db);

  // The open-submission guard and the insert it protects share one transaction under the
  // per-institution lock, so two simultaneous submissions cannot both find the queue empty. The
  // document rows join them: a failure part-way through now rolls the submission back rather than
  // leaving a queue row whose evidence is incomplete.
  const { submissionId, documentResults } = await db.transaction(async (tx) => {
    await acquireInstitutionSubmissionLock(tx, institutionId);
    await assertNoSubmissionAwaitingReview(tx, institutionId);

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

// Path B: the owner sends the official Instagram profile link of the workspace for staff to check.
// It stores no documents, needs no storage and draws no upload budget, and every kind of workspace
// may use it.
export const createInstagramTickRequest = async (
  institutionSlug: string,
  instagramUrl: string,
  actorUserId: string,
  db: Database = getDb(),
): Promise<SubmissionWithUploadUrls> => {
  const { institutionId, institutionType, verificationStatus, tickPath } =
    await resolveOwnerInstitution(institutionSlug, actorUserId, db);

  assertCanSubmitTickRequest(verificationStatus, tickPath);

  const emailDomainFlag = await deriveSubmitterEmailDomainFlag(institutionType, actorUserId, db);

  const submissionId = await db.transaction(async (tx) => {
    await acquireInstitutionSubmissionLock(tx, institutionId);

    const [institution] = await tx
      .select({
        verificationStatus: institutions.verificationStatus,
        nameProofDueAt: institutions.nameProofDueAt,
      })
      .from(institutions)
      .where(eq(institutions.id, institutionId))
      .limit(1);
    if (!institution) {
      throw new SubmissionError("institution_not_found", 404, "Institution not found");
    }

    await assertInstagramRequestAllowed(tx, { institutionId, ...institution });
    await assertNoSubmissionAwaitingReview(tx, institutionId);

    const [submissionRow] = await tx
      .insert(institutionVerificationSubmissions)
      .values({
        institutionId,
        submittedByUserId: actorUserId,
        targetInstitutionType: institutionType,
        emailDomainFlag,
        requestedPath: "instagram",
        instagramUrl,
      })
      .returning({ id: institutionVerificationSubmissions.id });
    if (!submissionRow) {
      throw new Error("Failed to create verification submission");
    }
    return submissionRow.id;
  });

  logger.info("institution.verification.instagram_request.created", {
    submissionId,
    institutionId,
    institutionType,
    actorUserId,
  });

  return { submissionId, documents: [] };
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
    institutionDisplayName: sub.institutionDisplayName,
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

  return rows;
};

// Platform ops: approve or reject a submission.
// On approval: transitions verification_status to verified. The institution's type never changes.
// All writes are atomic in one transaction (closes 6.5f.1-S1).
export const reviewVerificationSubmission = async (
  submissionId: string,
  decision: "approved" | "rejected",
  reviewerNotes: string | null,
  reviewerUserId: string,
  db: Database = getDb(),
): Promise<{
  submissionId: string;
  status: VerificationSubmissionStatus;
  // Only an approval carries it: whether the submitter became a trusted host through the tick.
  trustedSubmitter?: boolean;
}> => {
  const reviewed = await db.transaction(async (tx) => {
    // THE ACTOR IS READ FIRST, FROM THE DATABASE, AND THE `actorRole` PARAMETER IS GONE
    // (LAUNCH-D72, mirrors recruiter-tier-service.ts:120-129). The parameter used to be the
    // authority: the caller passed the session's role string and this function believed it. That
    // made the role a claim, and every audit row below records an actor id — so the claim and the
    // recorded actor could disagree with everything the database knows. `resolvePlatformOpsActor`
    // refuses a missing account, a non-platform_ops role and a suspended one, and the id it returns
    // is the one the database answered with.
    const actor = await resolvePlatformOpsActor(tx, reviewerUserId);

    // CAS guard: only pending_review submissions can be reviewed.
    const [sub] = await tx
      .select({
        id: institutionVerificationSubmissions.id,
        institutionId: institutionVerificationSubmissions.institutionId,
        targetInstitutionType: institutionVerificationSubmissions.targetInstitutionType,
        proposedDisplayName: institutionVerificationSubmissions.proposedDisplayName,
        status: institutionVerificationSubmissions.status,
        submittedByUserId: institutionVerificationSubmissions.submittedByUserId,
        requestedPath: institutionVerificationSubmissions.requestedPath,
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
        verificationStatus: institutions.verificationStatus,
        tickPath: institutions.tickPath,
        nameProofDueAt: institutions.nameProofDueAt,
      })
      .from(institutions)
      .where(eq(institutions.id, sub.institutionId))
      .limit(1);

    if (!inst) {
      throw new SubmissionError("institution_not_found", 404, "Institution not found");
    }

    // NOBODY DECIDES A SUBMISSION THEY FILED, OR AN INSTITUTION THEY BELONG TO, OR WERE INVITED INTO.
    // The rule is the shared one (operator-institution-conflict.ts) and it covers all three
    // relationships on both decision paths; what the reads above supply is the institution it is
    // asked about. Refused before any write, so a refused decision leaves the submission, the
    // institution, the audit trail and the mailer exactly as it found them.
    await assertOperatorHasNoInstitutionRelationship(tx, actor, sub.institutionId);

    const now = new Date();

    if (decision === "rejected") {
      // PINNED TO pending_review. Two reviewers rejecting the same submission at the same moment
      // both pass the status check above and both reach this UPDATE; without the pin both land, and
      // the loser's audit row describes a rejection that was the winner's. The pin makes exactly one
      // of them match a row, and the other is refused below without having written anything.
      const [rejected] = await tx
        .update(institutionVerificationSubmissions)
        .set({
          status: "rejected",
          reviewerUserId: actor.userId,
          reviewerNotes,
          reviewedAt: now,
        })
        .where(
          and(
            eq(institutionVerificationSubmissions.id, submissionId),
            eq(institutionVerificationSubmissions.status, "pending_review"),
          ),
        )
        .returning({ id: institutionVerificationSubmissions.id });

      if (!rejected) {
        throw new SubmissionError(
          "verification_transition_conflict",
          409,
          "This submission was reviewed while you were deciding. Reload and try again",
        );
      }

      // Audit every review decision — rejections are moderation actions just as approvals are.
      await tx.insert(institutionVerificationAudit).values({
        institutionId: sub.institutionId,
        actorUserId: actor.userId,
        fromStatus: inst.verificationStatus,
        toStatus: inst.verificationStatus,
        reason: reviewerNotes ?? null,
      });

      logger.info("institution.verification.submission.rejected", {
        submissionId,
        institutionId: sub.institutionId,
        reviewerUserId: actor.userId,
      });

      return { submissionId, status: "rejected" as const, institutionId: sub.institutionId };
    }

    // Approval path. Verification confirms an institution's documents; it never changes the
    // institution's type (fixed at creation) or its reach. It only transitions verification_status.
    //
    // Held to the same rulebook as the admin table's own transitions, so the two paths cannot
    // disagree about what is legal. This matters now that no status is terminal: an approval racing
    // a revocation must be refused by whichever loses, not silently applied on top.
    const isInstagramRequest = sub.requestedPath === "instagram";
    if (isInstagramRequest) {
      await assertInstagramRequestAllowed(tx, {
        institutionId: sub.institutionId,
        verificationStatus: inst.verificationStatus,
        nameProofDueAt: inst.nameProofDueAt,
      });
    }

    const isPathMoveOnDomainTick =
      inst.verificationStatus === "verified" && inst.tickPath === "domain";
    if (!isPathMoveOnDomainTick) assertValidTransition(inst.verificationStatus, "verified");

    await writeApprovedTick(tx, {
      institutionId: sub.institutionId,
      fromStatus: inst.verificationStatus,
      isPathMoveOnDomainTick,
      requestedPath: sub.requestedPath,
      actorUserId: actor.userId,
      reviewerNotes,
    });

    // Mark submission approved.
    await tx
      .update(institutionVerificationSubmissions)
      .set({ status: "approved", reviewerUserId: actor.userId, reviewerNotes, reviewedAt: now })
      .where(eq(institutionVerificationSubmissions.id, submissionId));

    const trustedSubmitter = await trustTickSubmitterInTransaction(tx, actor, {
      institutionId: sub.institutionId,
      submissionId,
      submitterUserId: sub.submittedByUserId,
      requestedPath: sub.requestedPath,
    });

    logger.info("institution.verification.submission.approved", {
      submissionId,
      institutionId: sub.institutionId,
      reviewerUserId: actor.userId,
    });

    return {
      submissionId,
      status: "approved" as const,
      institutionId: sub.institutionId,
      trustedSubmitter,
    };
  });

  if (reviewed.status !== "approved") {
    await enqueueTickNoticeAfterCommit({
      institutionId: reviewed.institutionId,
      kind: "tick_request_turned_down",
      ...(reviewerNotes === null ? {} : { reason: reviewerNotes }),
    });
    return { submissionId: reviewed.submissionId, status: reviewed.status };
  }

  await enqueueTickNoticeAfterCommit({
    institutionId: reviewed.institutionId,
    kind: "tick_granted",
  });

  return {
    submissionId: reviewed.submissionId,
    status: reviewed.status,
    trustedSubmitter: reviewed.trustedSubmitter,
  };
};
