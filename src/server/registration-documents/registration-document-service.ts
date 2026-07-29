// Participant document verification.
//
// An organizer asks ONE named participant for ONE named document by a named date. Everything here
// is orthogonal to participation: no function in this file reads or writes
// competition_registrations.status, competition_registrations.internal_review_status, submissions,
// or results. A request never gates anything.
//
// Two ownership chains guard the surface, and every entry point walks one of them end to end:
//   organizer  institution -> competition -> registration -> request -> file
//   candidate  session user -> registration -> request -> file
// Any break in either chain collapses to the same not-found error, so a cross-institution or
// cross-candidate id is indistinguishable from one that does not exist.

import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/registration-documents/registration-document-service");

import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionDocumentRequestFiles,
  competitionDocumentRequests,
  competitionRegistrations,
  competitions,
  institutionAuditLogs,
  institutions,
  users,
  type CompetitionDocumentRequestFileRecord,
  type CompetitionDocumentRequestRecord,
  type RegistrationDocumentRequestStatus,
} from "@/server/db/schema";
import { logger } from "@/lib/logger";
import {
  enqueueRegistrationDocumentRequested,
  enqueueRegistrationDocumentReviewed,
} from "@/server/async/enqueue";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";
import {
  allowedSourceStatesForVerdict,
  candidateMayModifyFiles,
  deriveRequestDisplayStatus,
  isOpenRequestStatus,
  type RegistrationDocumentDisplayState,
} from "@/lib/registration-documents/request-status";
import {
  DOCUMENT_RETENTION_GRACE_DAYS,
  RegistrationDocumentError,
  buildCompetitionObjectPrefix,
  buildRequestObjectPrefix,
  type DocumentFileDeclaration,
  type DocumentFileFinalizeInput,
  type DocumentRequestInput,
  type DocumentReviewInput,
} from "@/server/registration-documents/registration-document-core";
import {
  VERIFICATION_DOCUMENT_MAX_BYTES,
  buildContentDisposition,
  extensionMatchesMimeType,
  getFileExtension,
  isAllowedDocumentMimeType,
  mimeTypeForExtension,
  sanitizeFileName,
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

const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 300;
const PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = 300;
const SIGNATURE_READ_BYTES = 4096;

const assertStorageAvailable = (): void => {
  if (!isR2Available()) {
    throw new RegistrationDocumentError(
      "document_request_storage_unavailable",
      503,
      "Document storage is unavailable",
    );
  }
};

const notFound = (): never => {
  throw new RegistrationDocumentError("document_request_not_found", 404, "Request not found");
};

// Serializes concurrent creates against one participant. The one-open-request rule counts rows
// that do not exist yet, so an optimistic compare-and-set has no shared row to serialize on; the
// partial unique index sits behind this as a second line of defence.
const acquireRequestLock = async (
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  registrationId: string,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`reg_doc_request:${registrationId}`}))`,
  );
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type DocumentRequestFileView = {
  id: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
  createdAt: Date;
};

export type DocumentRequestView = {
  id: string;
  registrationId: string;
  title: string;
  instructions: string | null;
  dueAt: Date;
  status: RegistrationDocumentRequestStatus;
  display: RegistrationDocumentDisplayState;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  revisionCount: number;
  createdAt: Date;
  files: DocumentRequestFileView[];
};

const REQUEST_COLUMNS = {
  id: competitionDocumentRequests.id,
  registrationId: competitionDocumentRequests.registrationId,
  title: competitionDocumentRequests.title,
  instructions: competitionDocumentRequests.instructions,
  dueAt: competitionDocumentRequests.dueAt,
  status: competitionDocumentRequests.status,
  submittedAt: competitionDocumentRequests.submittedAt,
  reviewedAt: competitionDocumentRequests.reviewedAt,
  reviewNote: competitionDocumentRequests.reviewNote,
  revisionCount: competitionDocumentRequests.revisionCount,
  createdAt: competitionDocumentRequests.createdAt,
} as const;

type RequestRow = {
  id: string;
  registrationId: string;
  title: string;
  instructions: string | null;
  dueAt: Date;
  status: RegistrationDocumentRequestStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  revisionCount: number;
  createdAt: Date;
};

const loadFilesByRequestIds = async (
  requestIds: string[],
  db: Database,
): Promise<Map<string, DocumentRequestFileView[]>> => {
  const byRequest = new Map<string, DocumentRequestFileView[]>();
  if (requestIds.length === 0) return byRequest;

  const rows = await db
    .select({
      id: competitionDocumentRequestFiles.id,
      requestId: competitionDocumentRequestFiles.requestId,
      originalFileName: competitionDocumentRequestFiles.originalFileName,
      fileSizeBytes: competitionDocumentRequestFiles.fileSizeBytes,
      contentType: competitionDocumentRequestFiles.contentType,
      createdAt: competitionDocumentRequestFiles.createdAt,
    })
    .from(competitionDocumentRequestFiles)
    .where(inArray(competitionDocumentRequestFiles.requestId, requestIds))
    .orderBy(competitionDocumentRequestFiles.createdAt);

  for (const row of rows) {
    const list = byRequest.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      originalFileName: row.originalFileName,
      fileSizeBytes: row.fileSizeBytes,
      contentType: row.contentType,
      createdAt: row.createdAt,
    });
    byRequest.set(row.requestId, list);
  }
  return byRequest;
};

const toRequestView = (
  row: RequestRow,
  files: DocumentRequestFileView[],
  now: Date,
): DocumentRequestView => ({
  ...row,
  display: deriveRequestDisplayStatus(row, now),
  files,
});

// Walks institution -> competition -> registration -> request. Returns null on any break.
const loadRequestForInstitution = async (
  institutionId: string,
  requestId: string,
  db: Database,
): Promise<{ row: RequestRow; competitionId: string; candidateUserId: string } | null> => {
  const [found] = await db
    .select({
      ...REQUEST_COLUMNS,
      competitionId: competitions.id,
      candidateUserId: competitionRegistrations.studentId,
    })
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(
      and(
        eq(competitionDocumentRequests.id, requestId),
        eq(competitions.institutionId, institutionId),
      ),
    )
    .limit(1);

  if (!found) return null;
  const { competitionId, candidateUserId, ...row } = found;
  return { row, competitionId, candidateUserId };
};

// Walks session user -> registration -> request. Returns null on any break, so another candidate's
// request is indistinguishable from one that does not exist.
// Carries competitionId because the storage key is competition-scoped for retention.
const loadRequestForCandidate = async (
  userId: string,
  requestId: string,
  db: Database,
): Promise<(RequestRow & { competitionId: string }) | null> => {
  const [found] = await db
    .select({ ...REQUEST_COLUMNS, competitionId: competitionRegistrations.competitionId })
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .where(
      and(
        eq(competitionDocumentRequests.id, requestId),
        eq(competitionRegistrations.studentId, userId),
      ),
    )
    .limit(1);

  return found ?? null;
};

// Organizer-side read. Scoped to one competition the institution owns, and optionally narrowed to
// a single participant for their detail page.
export const listDocumentRequestsForCompetition = async (
  institutionId: string,
  competitionId: string,
  options: { registrationId?: string } = {},
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView[]> => {
  const rows = await db
    .select(REQUEST_COLUMNS)
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(
      and(
        eq(competitions.id, competitionId),
        eq(competitions.institutionId, institutionId),
        ...(options.registrationId
          ? [eq(competitionDocumentRequests.registrationId, options.registrationId)]
          : []),
      ),
    )
    .orderBy(desc(competitionDocumentRequests.createdAt));

  const files = await loadFilesByRequestIds(
    rows.map((row) => row.id),
    db,
  );
  return rows.map((row) => toRequestView(row, files.get(row.id) ?? [], now));
};

/**
 * Registration ids that could receive a new document request right now — the whole competition,
 * not one page of it.
 *
 * Backs the organizer's select-all: the participant table paginates, but the realistic ask is
 * "everyone who advanced", so the selectable set has to be the filtered set rather than whatever
 * happens to be on screen. Returns exactly what a batch would accept, so select-all can never
 * produce a request that is then skipped — cancelled registrations and anyone already holding an
 * open request are excluded here, in the same predicate the batch enforces.
 */
export const listRegistrationIdsEligibleForDocumentRequest = async (
  institutionId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string[]> => {
  const rows = await db
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitions.institutionId, institutionId),
        ne(competitionRegistrations.status, "cancelled"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${competitionDocumentRequests}
          WHERE ${competitionDocumentRequests.registrationId} = ${competitionRegistrations.id}
            AND ${competitionDocumentRequests.status} IN ('requested', 'submitted')
        )`,
      ),
    )
    .orderBy(competitionRegistrations.registeredAt);

  return rows.map((row) => row.id);
};

export const listDocumentRequestsForCandidate = async (
  userId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView[]> => {
  const rows = await db
    .select(REQUEST_COLUMNS)
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .where(eq(competitionRegistrations.studentId, userId))
    .orderBy(desc(competitionDocumentRequests.createdAt));

  const files = await loadFilesByRequestIds(
    rows.map((row) => row.id),
    db,
  );
  return rows.map((row) => toRequestView(row, files.get(row.id) ?? [], now));
};

// Requests attached to one registration, for the candidate's own registration page.
export const listDocumentRequestsForRegistration = async (
  userId: string,
  registrationId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView[]> => {
  const rows = await db
    .select(REQUEST_COLUMNS)
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .where(
      and(
        eq(competitionDocumentRequests.registrationId, registrationId),
        eq(competitionRegistrations.studentId, userId),
      ),
    )
    .orderBy(desc(competitionDocumentRequests.createdAt));

  const files = await loadFilesByRequestIds(
    rows.map((row) => row.id),
    db,
  );
  return rows.map((row) => toRequestView(row, files.get(row.id) ?? [], now));
};

// ---------------------------------------------------------------------------
// Organizer writes
// ---------------------------------------------------------------------------

export type BatchRequestOutcome = {
  created: Array<{ requestId: string; registrationId: string }>;
  // Participants the batch could not target, each with the reason. A skip is reported, never
  // thrown: one participant who already holds an open request must not cost the other ninety-five
  // theirs.
  skipped: Array<{ registrationId: string; reason: "already_open" | "not_in_competition" }>;
};

type CompetitionContext = { title: string; institutionName: string };

const loadCompetitionContext = async (
  institutionId: string,
  competitionId: string,
  db: Database,
): Promise<CompetitionContext | null> => {
  const [row] = await db
    .select({
      title: competitions.title,
      displayName: institutions.displayName,
      institutionType: institutions.institutionType,
      ownerUsername: users.username,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .leftJoin(users, eq(users.id, competitions.createdByUserId))
    .where(and(eq(competitions.id, competitionId), eq(competitions.institutionId, institutionId)))
    .limit(1);

  if (!row) return null;
  return {
    title: row.title,
    institutionName: getInstitutionDisplayName(
      { displayName: row.displayName, institutionType: row.institutionType },
      { username: row.ownerUsername },
    ),
  };
};

/**
 * Creates one document request per named participant.
 *
 * Registration ids are locked in sorted order so two overlapping batches can never deadlock, and
 * the whole batch shares a transaction: every audit row lands with its request or none does. A
 * participant who already holds an open request, or who is not registered for this competition, is
 * reported in `skipped` rather than failing the batch.
 *
 * Notifications are enqueued after commit and are fire-and-forget — an enqueue failure must never
 * fail the organizer's request or roll back a committed row.
 */
export const createDocumentRequestsForRegistrations = async (
  institutionId: string,
  competitionId: string,
  actorUserId: string,
  registrationIds: string[],
  input: DocumentRequestInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<BatchRequestOutcome> => {
  const context = await loadCompetitionContext(institutionId, competitionId, db);
  if (!context) return notFound();

  const registrations = await db
    .select({
      id: competitionRegistrations.id,
      studentId: competitionRegistrations.studentId,
    })
    .from(competitionRegistrations)
    .where(
      and(
        inArray(competitionRegistrations.id, registrationIds),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    );

  const candidateByRegistration = new Map(registrations.map((row) => [row.id, row.studentId]));
  const outcome: BatchRequestOutcome = { created: [], skipped: [] };

  for (const registrationId of registrationIds) {
    if (!candidateByRegistration.has(registrationId)) {
      outcome.skipped.push({ registrationId, reason: "not_in_competition" });
    }
  }

  const targets = registrationIds.filter((id) => candidateByRegistration.has(id)).sort();
  if (targets.length === 0) return outcome;

  await db.transaction(async (tx) => {
    for (const registrationId of targets) {
      await acquireRequestLock(tx, registrationId);

      const [open] = await tx
        .select({ id: competitionDocumentRequests.id })
        .from(competitionDocumentRequests)
        .where(
          and(
            eq(competitionDocumentRequests.registrationId, registrationId),
            inArray(competitionDocumentRequests.status, ["requested", "submitted"]),
          ),
        )
        .limit(1);

      if (open) {
        outcome.skipped.push({ registrationId, reason: "already_open" });
        continue;
      }

      const [inserted] = await tx
        .insert(competitionDocumentRequests)
        .values({
          registrationId,
          title: input.title,
          instructions: input.instructions,
          dueAt: input.dueAt,
          status: "requested",
          requestedByUserId: actorUserId,
        })
        .returning({ id: competitionDocumentRequests.id });

      if (!inserted) throw new Error("document request insert returned no row");

      await tx.insert(institutionAuditLogs).values({
        institutionId,
        actorUserId,
        action: "document_request.created",
        metadata: {
          competitionId,
          registrationId,
          requestId: inserted.id,
          title: input.title,
          dueAt: input.dueAt.toISOString(),
        },
      });

      outcome.created.push({ requestId: inserted.id, registrationId });
    }
  });

  const epoch = now.getTime();
  for (const created of outcome.created) {
    const userId = candidateByRegistration.get(created.registrationId);
    if (!userId) continue;
    enqueueRegistrationDocumentRequested({
      requestId: created.requestId,
      userId,
      competitionTitle: context.title,
      institutionName: context.institutionName,
      title: input.title,
      instructions: input.instructions,
      dueAtIso: input.dueAt.toISOString(),
      epoch,
    }).catch((error: unknown) => {
      logger.warn("registration.document.requested.enqueue_failed", {
        requestId: created.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return outcome;
};

// Single-participant create. A skip is a 409 here, because the organizer named one person and is
// entitled to know the ask did not land.
export const createDocumentRequest = async (
  institutionId: string,
  competitionId: string,
  actorUserId: string,
  registrationId: string,
  input: DocumentRequestInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ requestId: string }> => {
  const outcome = await createDocumentRequestsForRegistrations(
    institutionId,
    competitionId,
    actorUserId,
    [registrationId],
    input,
    db,
    now,
  );

  const created = outcome.created[0];
  if (created) return { requestId: created.requestId };

  const skip = outcome.skipped[0];
  if (skip?.reason === "already_open") {
    throw new RegistrationDocumentError(
      "document_request_already_open",
      409,
      "This participant already has an open document request",
    );
  }
  return notFound();
};

/**
 * Records the verdict on a request.
 *
 * The two verdicts have deliberately different source states. `accept` requires an upload to
 * accept. `reject` does not: a request that was never answered and a document that was answered
 * and judged insufficient are both legitimate grounds, and an institution running zero tolerance
 * must be able to refuse a file that is present, on time and perfectly legible. Nothing here
 * treats the existence of a file as an argument for accepting it.
 *
 * A rejection that allows another attempt returns the request to `requested` with a fresh
 * deadline, retains the reason so the candidate keeps seeing what was wrong, increments
 * revision_count, and clears submitted_at so the next upload stamps its own time.
 */
export const reviewDocumentRequest = async (
  institutionId: string,
  actorUserId: string,
  requestId: string,
  review: DocumentReviewInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView> => {
  const found = await loadRequestForInstitution(institutionId, requestId, db);
  if (!found) return notFound();

  const allowedFrom = allowedSourceStatesForVerdict(review.verdict);

  const reopening = review.verdict === "reject" && review.allowReupload;
  const nextStatus: RegistrationDocumentRequestStatus = reopening
    ? "requested"
    : review.verdict === "accept"
      ? "accepted"
      : "rejected";

  const context = await loadCompetitionContext(institutionId, found.competitionId, db);

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(competitionDocumentRequests)
      .set({
        status: nextStatus,
        reviewNote: review.note,
        reviewedByUserId: actorUserId,
        reviewedAt: now,
        ...(reopening
          ? {
              dueAt: review.dueAt,
              submittedAt: null,
              revisionCount: sql`${competitionDocumentRequests.revisionCount} + 1`,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(competitionDocumentRequests.id, requestId),
          inArray(competitionDocumentRequests.status, allowedFrom),
        ),
      )
      .returning(REQUEST_COLUMNS);

    const row = rows[0];
    if (!row) {
      throw new RegistrationDocumentError(
        "document_request_wrong_status",
        409,
        review.verdict === "accept"
          ? "Only a request with an uploaded document can be accepted"
          : "This request has already been decided",
      );
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      actorUserId,
      action: "document_request.reviewed",
      metadata: {
        competitionId: found.competitionId,
        registrationId: found.row.registrationId,
        requestId,
        verdict: review.verdict,
        reopened: reopening,
        note: review.verdict === "reject" ? review.note : null,
      },
    });

    return row;
  });

  const files = await loadFilesByRequestIds([requestId], db);

  enqueueRegistrationDocumentReviewed({
    requestId,
    userId: found.candidateUserId,
    competitionTitle: context?.title ?? "",
    title: found.row.title,
    outcome: reopening
      ? "revision_requested"
      : review.verdict === "accept"
        ? "accepted"
        : "rejected",
    reviewNote: review.note,
    dueAtIso: reopening ? review.dueAt.toISOString() : null,
    epoch: now.getTime(),
  }).catch((error: unknown) => {
    logger.warn("registration.document.reviewed.enqueue_failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return toRequestView(updated, files.get(requestId) ?? [], now);
};

// Pushes an open request's deadline out. Reachable from `requested` and `submitted` — extending a
// request whose document is already in hand is harmless, and blocking it would only be a puzzle.
export const extendDocumentRequestDeadline = async (
  institutionId: string,
  actorUserId: string,
  requestId: string,
  dueAt: Date,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView> => {
  const found = await loadRequestForInstitution(institutionId, requestId, db);
  if (!found) return notFound();

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(competitionDocumentRequests)
      .set({ dueAt, updatedAt: now })
      .where(
        and(
          eq(competitionDocumentRequests.id, requestId),
          inArray(competitionDocumentRequests.status, ["requested", "submitted"]),
        ),
      )
      .returning(REQUEST_COLUMNS);

    const row = rows[0];
    if (!row) {
      throw new RegistrationDocumentError(
        "document_request_wrong_status",
        409,
        "Only an open request can have its deadline extended",
      );
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      actorUserId,
      action: "document_request.deadline_extended",
      metadata: {
        competitionId: found.competitionId,
        registrationId: found.row.registrationId,
        requestId,
        dueAt: dueAt.toISOString(),
      },
    });

    return row;
  });

  const files = await loadFilesByRequestIds([requestId], db);
  return toRequestView(updated, files.get(requestId) ?? [], now);
};

// Withdraws a request the organizer no longer needs. Distinct from a rejection: nothing is being
// judged, so no reason is required and no verdict notification is sent.
export const cancelDocumentRequest = async (
  institutionId: string,
  actorUserId: string,
  requestId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<DocumentRequestView> => {
  const found = await loadRequestForInstitution(institutionId, requestId, db);
  if (!found) return notFound();

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(competitionDocumentRequests)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(competitionDocumentRequests.id, requestId),
          inArray(competitionDocumentRequests.status, ["requested", "submitted"]),
        ),
      )
      .returning(REQUEST_COLUMNS);

    const row = rows[0];
    if (!row) {
      throw new RegistrationDocumentError(
        "document_request_wrong_status",
        409,
        "Only an open request can be withdrawn",
      );
    }

    await tx.insert(institutionAuditLogs).values({
      institutionId,
      actorUserId,
      action: "document_request.cancelled",
      metadata: {
        competitionId: found.competitionId,
        registrationId: found.row.registrationId,
        requestId,
      },
    });

    return row;
  });

  const files = await loadFilesByRequestIds([requestId], db);
  return toRequestView(updated, files.get(requestId) ?? [], now);
};

/**
 * Mints a short-lived presigned GET for one attached file, for an organizer who owns the
 * competition.
 *
 * The access is audited. Every other read in the app goes unrecorded, but this one hands an
 * organizer a student's identity document, and "who opened this person's ID card" has to be an
 * answerable question. The audit row is written before the URL is minted, so a storage failure
 * cannot produce an unrecorded read.
 */
export const resolveRequestFileUrlForInstitution = async (
  institutionId: string,
  actorUserId: string,
  requestId: string,
  fileId: string,
  disposition: "inline" | "attachment",
  db: Database = getDb(),
): Promise<{ url: string }> => {
  assertStorageAvailable();

  const found = await loadRequestForInstitution(institutionId, requestId, db);
  if (!found) return notFound();

  const [file] = await db
    .select({
      r2Key: competitionDocumentRequestFiles.r2Key,
      originalFileName: competitionDocumentRequestFiles.originalFileName,
      contentType: competitionDocumentRequestFiles.contentType,
    })
    .from(competitionDocumentRequestFiles)
    .where(
      and(
        eq(competitionDocumentRequestFiles.id, fileId),
        eq(competitionDocumentRequestFiles.requestId, requestId),
      ),
    )
    .limit(1);

  if (!file) {
    throw new RegistrationDocumentError(
      "document_request_file_not_found",
      404,
      "Document not found",
    );
  }

  await db.insert(institutionAuditLogs).values({
    institutionId,
    actorUserId,
    action: "document_request.file_accessed",
    metadata: {
      competitionId: found.competitionId,
      registrationId: found.row.registrationId,
      requestId,
      fileId,
      disposition,
    },
  });

  const url = await generatePresignedGetUrl(file.r2Key, PRESIGNED_DOWNLOAD_EXPIRY_SECONDS, {
    responseContentType: file.contentType,
    responseContentDisposition: buildContentDisposition(disposition, file.originalFileName),
  });
  return { url };
};

// ---------------------------------------------------------------------------
// Candidate writes
// ---------------------------------------------------------------------------

// Reclaims objects under a request's prefix that no file row references — an upload that was PUT
// but never finalized, or one replaced by a later attempt. Never throws: a storage hiccup must not
// break the upload it runs beside.
export const sweepOrphanedRequestObjects = async (
  competitionId: string,
  registrationId: string,
  requestId: string,
  options: { respectAge: boolean },
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;

  const prefix = buildRequestObjectPrefix(competitionId, registrationId, requestId);
  try {
    const objects = await listObjects(prefix);
    if (objects.length === 0) return;

    const rows = await db
      .select({ r2Key: competitionDocumentRequestFiles.r2Key })
      .from(competitionDocumentRequestFiles)
      .where(eq(competitionDocumentRequestFiles.requestId, requestId));
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
    logger.warn("registration_document.orphan_sweep_failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const requireOpenRequestForCandidate = async (
  userId: string,
  requestId: string,
  db: Database,
): Promise<RequestRow & { competitionId: string }> => {
  const row = await loadRequestForCandidate(userId, requestId, db);
  if (!row) return notFound();
  if (!isOpenRequestStatus(row.status)) {
    throw new RegistrationDocumentError(
      "document_request_wrong_status",
      409,
      "This request is closed and no longer accepts uploads",
    );
  }
  return row;
};

// Presign step. Validates the declared file against the allowlist and returns a presigned PUT plus
// the server-chosen key. Writes no row — the row is created only once finalize has inspected the
// bytes that actually landed, so an abandoned or forged upload never becomes a visible document.
export const prepareRequestDocumentUpload = async (
  userId: string,
  requestId: string,
  file: DocumentFileDeclaration,
  db: Database = getDb(),
): Promise<{ uploadUrl: string; r2Key: string }> => {
  assertStorageAvailable();

  const mimeForExtension = mimeTypeForExtension(getFileExtension(file.originalFileName));
  if (!mimeForExtension) {
    throw new RegistrationDocumentError(
      "document_request_file_type_not_allowed",
      422,
      "Only PDF, JPG, PNG, or WebP files are accepted",
    );
  }
  if (!isAllowedDocumentMimeType(file.contentType) || file.contentType !== mimeForExtension) {
    throw new RegistrationDocumentError(
      "document_request_file_type_not_allowed",
      422,
      "The declared file type does not match its extension",
    );
  }
  if (!Number.isFinite(file.fileSizeBytes) || file.fileSizeBytes <= 0) {
    throw new RegistrationDocumentError("document_request_file_invalid", 422, "The file is empty");
  }
  if (file.fileSizeBytes > VERIFICATION_DOCUMENT_MAX_BYTES) {
    throw new RegistrationDocumentError(
      "document_request_file_too_large",
      422,
      "The file exceeds the 10 MB limit",
    );
  }

  const request = await requireOpenRequestForCandidate(userId, requestId, db);

  await sweepOrphanedRequestObjects(
    request.competitionId,
    request.registrationId,
    requestId,
    { respectAge: true },
    db,
  );

  const r2Key = `${buildRequestObjectPrefix(request.competitionId, request.registrationId, requestId)}${crypto.randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    r2Key,
    file.contentType,
    PRESIGNED_UPLOAD_EXPIRY_SECONDS,
  );
  return { uploadUrl, r2Key };
};

/**
 * Finalize step, run after the browser has PUT the file.
 *
 * Verifies the object against server-observed truth — its real size from a HEAD, and its
 * magic-byte-detected type from a ranged read of the header — and only then writes the row. The
 * persisted content type is the detected one, never the client's claim. A file that fails any
 * check is deleted from storage and no row is created.
 */
export const finalizeRequestDocumentUpload = async (
  userId: string,
  requestId: string,
  input: DocumentFileFinalizeInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<CompetitionDocumentRequestFileRecord> => {
  assertStorageAvailable();

  const request = await requireOpenRequestForCandidate(userId, requestId, db);

  const expectedPrefix = buildRequestObjectPrefix(
    request.competitionId,
    request.registrationId,
    requestId,
  );
  if (!input.r2Key.startsWith(expectedPrefix)) {
    throw new RegistrationDocumentError(
      "document_request_file_invalid",
      422,
      "The upload key is not scoped to this request",
    );
  }

  const head = await headObject(input.r2Key);
  if (!head) {
    throw new RegistrationDocumentError(
      "document_request_file_not_found",
      404,
      "The uploaded file was not found in storage",
    );
  }
  if (head.sizeBytes <= 0 || head.sizeBytes > VERIFICATION_DOCUMENT_MAX_BYTES) {
    await deleteObject(input.r2Key);
    throw new RegistrationDocumentError(
      "document_request_file_too_large",
      422,
      "The file exceeds the 10 MB limit",
    );
  }

  const headBytes = await readObjectHead(input.r2Key, SIGNATURE_READ_BYTES);
  const detected = detectFileType(headBytes);
  if (!detected || !extensionMatchesMimeType(input.originalFileName, detected)) {
    await deleteObject(input.r2Key);
    throw new RegistrationDocumentError(
      "document_request_file_invalid",
      422,
      "The file content does not match an accepted document type",
    );
  }

  const row = await db.transaction(async (tx) => {
    const [file] = await tx
      .insert(competitionDocumentRequestFiles)
      .values({
        requestId,
        r2Key: input.r2Key,
        originalFileName: sanitizeFileName(input.originalFileName),
        fileSizeBytes: head.sizeBytes,
        contentType: detected,
      })
      .returning();
    if (!file) throw new Error("document file insert returned no row");

    // The first file moves the request from awaiting-an-upload to awaiting-a-verdict. A late
    // upload still lands: submitted_at is recorded and compared against due_at at read time, so
    // the reviewer sees it was late rather than the candidate being locked out.
    await tx
      .update(competitionDocumentRequests)
      .set({ status: "submitted", submittedAt: now, updatedAt: now })
      .where(
        and(
          eq(competitionDocumentRequests.id, requestId),
          eq(competitionDocumentRequests.status, "requested"),
        ),
      );

    return file;
  });

  await sweepOrphanedRequestObjects(
    request.competitionId,
    request.registrationId,
    requestId,
    { respectAge: true },
    db,
  );

  return row;
};

/**
 * Removes one of the candidate's own attached files.
 *
 * Permitted only while the request is open — including after a rejection reopened it, so a photo
 * that could not be read can be swapped. Once a verdict lands the document is frozen either way:
 * it is the evidence that verdict rests on, and a record the organizer accepted is worth nothing if
 * the subject can remove it afterwards. Purging a document that has outlived its purpose is a
 * platform-side retention concern, not something either party reaches into by hand.
 *
 * The row is deleted before the object, so a storage failure leaves an orphan the sweep reclaims
 * rather than a row pointing at bytes that are already gone.
 */
export const deleteRequestDocumentFile = async (
  userId: string,
  fileId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<void> => {
  const [file] = await db
    .select({
      id: competitionDocumentRequestFiles.id,
      r2Key: competitionDocumentRequestFiles.r2Key,
      requestId: competitionDocumentRequestFiles.requestId,
      status: competitionDocumentRequests.status,
    })
    .from(competitionDocumentRequestFiles)
    .innerJoin(
      competitionDocumentRequests,
      eq(competitionDocumentRequests.id, competitionDocumentRequestFiles.requestId),
    )
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .where(
      and(
        eq(competitionDocumentRequestFiles.id, fileId),
        eq(competitionRegistrations.studentId, userId),
      ),
    )
    .limit(1);

  if (!file) {
    throw new RegistrationDocumentError(
      "document_request_file_not_found",
      404,
      "Document not found",
    );
  }

  if (!candidateMayModifyFiles(file.status)) {
    throw new RegistrationDocumentError(
      "document_request_wrong_status",
      409,
      "This document can no longer be removed",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(competitionDocumentRequestFiles)
      .where(eq(competitionDocumentRequestFiles.id, fileId));

    // Removing the last file while awaiting a verdict returns the request to awaiting-an-upload,
    // so a reviewer is never shown an empty submission to decide on.
    const [remaining] = await tx
      .select({ id: competitionDocumentRequestFiles.id })
      .from(competitionDocumentRequestFiles)
      .where(eq(competitionDocumentRequestFiles.requestId, file.requestId))
      .limit(1);

    if (!remaining) {
      await tx
        .update(competitionDocumentRequests)
        .set({ status: "requested", submittedAt: null, updatedAt: now })
        .where(
          and(
            eq(competitionDocumentRequests.id, file.requestId),
            eq(competitionDocumentRequests.status, "submitted"),
          ),
        );
    }
  });

  try {
    await deleteObject(file.r2Key);
  } catch (error) {
    logger.warn("registration_document.object_delete_failed", {
      fileId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Competitions whose collected documents have outlived their purpose.
 *
 * A competition qualifies once its event ended more than `graceDays` ago and it still holds at
 * least one document. The grace period exists because disputes surface late — a prize challenged
 * weeks after the ceremony still needs the evidence — so the window is deliberately generous.
 *
 * Keyed on `event_end_at` rather than on the organizer archiving the competition: archiving is a
 * manual act, and the organizers least likely to perform it are exactly the ones whose documents
 * most need clearing. A competition with no recorded end date is skipped rather than purged, since
 * nothing establishes that it is over.
 */
export const listCompetitionsDueForDocumentPurge = async (
  graceDays: number = DOCUMENT_RETENTION_GRACE_DAYS,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<string[]> => {
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .selectDistinct({ competitionId: competitionRegistrations.competitionId })
    .from(competitionDocumentRequestFiles)
    .innerJoin(
      competitionDocumentRequests,
      eq(competitionDocumentRequests.id, competitionDocumentRequestFiles.requestId),
    )
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(and(isNotNull(competitions.eventEndAt), lt(competitions.eventEndAt, cutoff)));

  return rows.map((row) => row.competitionId);
};

export type DocumentPurgeOutcome = {
  objectsDeleted: number;
  fileRowsDeleted: number;
};

/**
 * Deletes every identity document one competition collected, and the rows that point at them.
 *
 * What survives is the request itself: title, deadline, verdict, reviewer, timestamps, and the
 * audit trail of who opened what. So the permanent answer to "was this participant verified, by
 * whom, and when" is intact, while the identity documents backing it are gone. That split is the
 * whole point — the record is what the organizer needs; the ID card is a liability the moment it
 * stops being evidence.
 *
 * Deletion works from the storage prefix rather than from the file rows, so anything abandoned
 * under that competition — an upload that was PUT and never finalized — goes with the rest. Rows
 * are removed after the objects, so a storage failure leaves rows pointing at bytes to retry
 * against rather than orphaned bytes nothing remembers.
 */
export const purgeDocumentsForCompetition = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<DocumentPurgeOutcome> => {
  if (!isR2Available()) {
    throw new RegistrationDocumentError(
      "document_request_storage_unavailable",
      503,
      "Document storage is unavailable",
    );
  }

  const prefix = buildCompetitionObjectPrefix(competitionId);
  const objects = await listObjects(prefix);

  let objectsDeleted = 0;
  for (const object of objects) {
    await deleteObject(object.key);
    objectsDeleted += 1;
  }

  const requestIds = await db
    .select({ id: competitionDocumentRequests.id })
    .from(competitionDocumentRequests)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionDocumentRequests.registrationId),
    )
    .where(eq(competitionRegistrations.competitionId, competitionId));

  if (requestIds.length === 0) {
    return { objectsDeleted, fileRowsDeleted: 0 };
  }

  const deleted = await db
    .delete(competitionDocumentRequestFiles)
    .where(
      inArray(
        competitionDocumentRequestFiles.requestId,
        requestIds.map((row) => row.id),
      ),
    )
    .returning({ id: competitionDocumentRequestFiles.id });

  logger.info("registration_document.purged", {
    competitionId,
    objectsDeleted,
    fileRowsDeleted: deleted.length,
  });

  return { objectsDeleted, fileRowsDeleted: deleted.length };
};

export type { CompetitionDocumentRequestRecord };
