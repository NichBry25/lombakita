import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/submissions/submission-service");

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  competitionSubmissions,
  teamMemberships,
  type SubmissionRecord,
} from "@/server/db/schema";
import {
  deleteObject,
  generatePresignedPutUrl,
  headObject,
  isR2Available,
  listObjects,
  readObjectHead,
} from "@/server/storage/r2.client";
import { detectFileFamily } from "@/server/storage/file-signature";
import {
  isSubmissionWindowOpen,
  SubmissionError,
  type ValidatedFileMetadata,
} from "@/server/submissions/submission-core";
import {
  buildSubmissionCompetitionPrefix,
  buildSubmissionRegistrationPrefix,
  SUBMISSIONS_MAX_FILE_SIZE_BYTES,
  SUBMISSIONS_UPLOAD_EXPIRY_SECONDS,
  UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS,
} from "@/server/submissions/submission-constants";
import {
  familyMatchesFileName,
  SUBMISSION_FORMAT_HINT,
  submissionMimeTypeForFileName,
} from "@/lib/submissions/submission-file";
import { logger } from "@/lib/logger";
import { enqueueSubmissionFinalized } from "@/server/async/enqueue";

// ── Access resolution ───────────────────────────────────────────────────────

type AccessRegistration = {
  id: string;
  competitionId: string;
  registrationType: "individual" | "team";
  status: "confirmed" | "cancelled" | "pending_payment";
  studentId: string;
  teamId: string | null;
};

type AccessCompetition = {
  id: string;
  title: string;
  slug: string;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
};

export type SubmissionAccess = {
  registration: AccessRegistration;
  competition: AccessCompetition;
};

// Load the registration joined to its competition (for event dates + competitionId cross-check).
// Soft-deleted competitions are excluded — their registration surface returns null (→ 404).
const loadRegistrationWithCompetition = async (
  registrationId: string,
  db: Database,
): Promise<SubmissionAccess | null> => {
  const [row] = await db
    .select({
      registrationId: competitionRegistrations.id,
      competitionId: competitionRegistrations.competitionId,
      registrationType: competitionRegistrations.registrationType,
      registrationStatus: competitionRegistrations.status,
      studentId: competitionRegistrations.studentId,
      teamId: competitionRegistrations.teamId,
      competitionTitle: competitions.title,
      competitionSlug: competitions.slug,
      eventStartAt: competitions.eventStartAt,
      eventEndAt: competitions.eventEndAt,
    })
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(and(eq(competitionRegistrations.id, registrationId), isNull(competitions.deletedAt)))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    registration: {
      id: row.registrationId,
      competitionId: row.competitionId,
      registrationType: row.registrationType,
      status: row.registrationStatus,
      studentId: row.studentId,
      teamId: row.teamId,
    },
    competition: {
      id: row.competitionId,
      title: row.competitionTitle,
      slug: row.competitionSlug,
      eventStartAt: row.eventStartAt,
      eventEndAt: row.eventEndAt,
    },
  };
};

// The submission access boundary. Individual: the registering candidate only. Team: ANY active
// team member (not just the captain). Returns a boolean — callers map false to a 404 with no
// info leak.
const canAccessRegistration = async (
  registration: AccessRegistration,
  userId: string,
  db: Database,
): Promise<boolean> => {
  if (registration.registrationType === "individual") {
    return registration.studentId === userId;
  }

  if (!registration.teamId) {
    return false;
  }

  const [membership] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, registration.teamId),
        eq(teamMemberships.userId, userId),
        eq(teamMemberships.status, "active"),
      ),
    )
    .limit(1);

  return Boolean(membership);
};

// Resolve access for a (competitionId, registrationId, userId) triple. Returns null on ANY access
// failure — registration missing, URL competitionId not matching the registration's competition
// (cross-competition IDOR), or caller not authorized for the registration. The single null path
// keeps the surface from leaking whether a registration exists.
export const resolveSubmissionAccess = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  db: Database = getDb(),
): Promise<SubmissionAccess | null> => {
  const loaded = await loadRegistrationWithCompetition(registrationId, db);

  if (!loaded) {
    return null;
  }

  // Cross-competition IDOR guard: the URL's competitionId must own this registration.
  if (loaded.registration.competitionId !== competitionId) {
    return null;
  }

  const allowed = await canAccessRegistration(loaded.registration, userId, db);

  if (!allowed) {
    return null;
  }

  return loaded;
};

const requireAccess = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  db: Database,
): Promise<SubmissionAccess> => {
  const access = await resolveSubmissionAccess(competitionId, registrationId, userId, db);

  if (!access) {
    throw new SubmissionError("submission_registration_not_found", "Registration not found");
  }

  return access;
};

// A cancelled registration blocks every submission operation (read, upload-url, record,
// finalize) — see the Step 4.6 manual test seeds.
const assertNotCancelled = (registration: AccessRegistration): void => {
  if (registration.status === "cancelled") {
    throw new SubmissionError(
      "submission_registration_cancelled",
      "Registration has been cancelled — submissions are closed",
    );
  }
};

const getSubmissionRow = async (
  registrationId: string,
  db: Database,
): Promise<SubmissionRecord | null> => {
  const [row] = await db
    .select()
    .from(competitionSubmissions)
    .where(eq(competitionSubmissions.registrationId, registrationId))
    .limit(1);

  return row ?? null;
};

// ── Public service functions ─────────────────────────────────────────────────

// Read the current submission for a registration the caller can access. Returns null when access
// is granted but no submission has been recorded yet. A cancelled registration is blocked.
export const getSubmission = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  db: Database = getDb(),
): Promise<SubmissionRecord | null> => {
  const { registration } = await requireAccess(competitionId, registrationId, userId, db);
  assertNotCancelled(registration);
  return getSubmissionRow(registrationId, db);
};

export type UploadUrlGrant = {
  uploadUrl: string;
  fileKey: string;
  expiresAt: Date;
  // The content type bound into the signed URL. The browser MUST send exactly this on the PUT or
  // R2 rejects the signature, so it is returned rather than left for the client to guess.
  contentType: string;
};

// Mint a presigned PUT URL the browser uses to upload a file directly to R2. The generated key is
// `submissions/{registrationId}/{uuid}` — the candidate cannot choose the key, so it is always
// correctly scoped. Degrades to a 503 (submission_upload_unavailable), never a 500, when R2 is
// not configured.
export const generateSubmissionUploadUrl = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  // No declared MIME: the accepted type is derived from the filename and confirmed against the
  // stored bytes later, so a client-supplied content type has nothing left to influence.
  input: { fileName: string },
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<UploadUrlGrant> => {
  const { registration, competition } = await requireAccess(
    competitionId,
    registrationId,
    userId,
    db,
  );

  if (typeof input.fileName !== "string" || input.fileName.trim().length === 0) {
    throw new SubmissionError("submission_invalid_payload", "fileName is required");
  }

  // Advisory format gate: the declared filename is client-controlled, so this only fails fast on
  // an obviously unacceptable upload. The authoritative check runs against the stored bytes in
  // createOrReplaceSubmission.
  const declaredMimeType = submissionMimeTypeForFileName(input.fileName);
  if (declaredMimeType === null) {
    throw new SubmissionError(
      "submission_invalid_file_type",
      `File format is not accepted. Allowed formats: ${SUBMISSION_FORMAT_HINT}`,
      { details: { allowedFormats: SUBMISSION_FORMAT_HINT } },
    );
  }

  if (!isSubmissionWindowOpen(competition, now)) {
    throw new SubmissionError(
      "submission_window_closed",
      "The submission window for this competition is not open",
    );
  }

  assertNotCancelled(registration);

  if (!isR2Available()) {
    throw new SubmissionError(
      "submission_upload_unavailable",
      "File storage is not configured — uploads are temporarily unavailable",
    );
  }

  // The signed URL binds the type implied by the FILENAME, not the browser's own `file.type` — it
  // is empty for several accepted formats and client-controlled in every case. The upload must
  // then be PUT with that same content type or R2 rejects the signature.
  // `requireAccess` has already confirmed this competitionId owns this registration, so it is safe
  // to build the key from it rather than re-reading the registration's own competition.
  const fileKey = `${buildSubmissionRegistrationPrefix(competitionId, registrationId)}${randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    fileKey,
    declaredMimeType,
    SUBMISSIONS_UPLOAD_EXPIRY_SECONDS,
  );
  const expiresAt = new Date(now.getTime() + SUBMISSIONS_UPLOAD_EXPIRY_SECONDS * 1000);

  // Reclaim anything left by an earlier attempt before adding another key to this prefix.
  await sweepOrphanedObjectsForRegistration(competitionId, registrationId, db, now);

  return { uploadUrl, fileKey, expiresAt, contentType: declaredMimeType };
};

/**
 * Reclaims objects under a registration's submission prefix that the current submission row does
 * not reference — an upload that was presigned and PUT but never recorded, or one replaced by a
 * later attempt whose cleanup did not land.
 *
 * Never throws: a storage hiccup must not break the upload it runs beside. Objects younger than
 * the presign window are left alone, since an upload may be in flight against them right now.
 */
export const sweepOrphanedObjectsForRegistration = async (
  competitionId: string,
  registrationId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<void> => {
  if (!isR2Available()) return;

  try {
    const prefix = buildSubmissionRegistrationPrefix(competitionId, registrationId);
    const objects = await listObjects(prefix);
    if (objects.length === 0) return;

    const current = await getSubmissionRow(registrationId, db);
    const referenced = current ? current.fileKey : null;
    const cutoff = now.getTime() - SUBMISSIONS_UPLOAD_EXPIRY_SECONDS * 1000;

    for (const object of objects) {
      if (object.key === referenced) continue;
      if (object.lastModified && object.lastModified.getTime() > cutoff) continue;
      await deleteObject(object.key);
    }
  } catch (err: unknown) {
    logger.warn("submission.orphan_sweep_failed", {
      registrationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// How much of the stored object to read back for signature detection. Every supported signature
// lives in the first few bytes; 4 KB matches the document pipeline and costs one ranged GET.
const SIGNATURE_READ_BYTES = 4096;

type ConfirmedFile = {
  contentType: string;
  sizeBytes: number;
};

/**
 * Confirms that the object actually stored at `fileKey` is a file this platform accepts, and
 * returns the content type and size to persist.
 *
 * This is the authoritative half of the upload-security model. Everything the client said —
 * filename type, size, MIME — is a claim; the bytes in the bucket are not. A file that fails any
 * check is deleted from R2 and no row is written, so a rejected upload leaves nothing behind.
 *
 * The extension still matters after detection: the signature proves the FAMILY (a .docx and a
 * .zip are both zip containers), and the extension selects the specific format within a family
 * the bytes have already confirmed.
 */
const confirmStoredFile = async (fileKey: string, fileName: string): Promise<ConfirmedFile> => {
  const rejectFile = async (message: string): Promise<never> => {
    // Best-effort: a storage hiccup while cleaning up must not mask the validation failure the
    // caller needs to see.
    await deleteObject(fileKey).catch((err: unknown) => {
      logger.warn("submission.rejected_file.delete_failed", {
        fileKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    throw new SubmissionError("submission_invalid_file_type", message, {
      details: { allowedFormats: SUBMISSION_FORMAT_HINT },
    });
  };

  const head = await headObject(fileKey);
  if (!head) {
    // Nothing to delete — the PUT never landed.
    throw new SubmissionError(
      "submission_file_missing",
      "No uploaded file was found for this key. Upload the file before saving it.",
    );
  }

  if (head.sizeBytes === 0) {
    return rejectFile("The uploaded file is empty");
  }

  if (head.sizeBytes > SUBMISSIONS_MAX_FILE_SIZE_BYTES) {
    return rejectFile("The uploaded file exceeds the maximum size");
  }

  const headBytes = await readObjectHead(fileKey, SIGNATURE_READ_BYTES);
  const family = detectFileFamily(headBytes);

  if (family === null || !familyMatchesFileName(fileName, family)) {
    return rejectFile(
      `File contents do not match its name or are not an accepted format. Allowed formats: ${SUBMISSION_FORMAT_HINT}`,
    );
  }

  const contentType = submissionMimeTypeForFileName(fileName);
  if (contentType === null) {
    return rejectFile(`File format is not accepted. Allowed formats: ${SUBMISSION_FORMAT_HINT}`);
  }

  return { contentType, sizeBytes: head.sizeBytes };
};

// Record (create) or replace submission metadata after the file has been uploaded to R2.
// Replace semantics: an UPSERT on registration_id. The finalized guard lives in the DB WHERE
// clause of the conflict update (setWhere: finalized_at IS NULL) — NOT a read-before-write check
// — so a finalized row cannot be overwritten even under a concurrent race. When the conflict
// update matches no row (the existing submission is finalized), the upsert returns nothing and we
// raise submission_finalized. On insert, version starts at 1; on replace, version increments by 1
// and finalized_at is left untouched (still null by the WHERE guard).
//
// The stored file is confirmed against its own bytes before anything is written, and the size and
// content type persisted are the ones read back from R2 — the client's reported values are used
// only to fail fast, never to describe the row.
export const createOrReplaceSubmission = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  metadata: ValidatedFileMetadata,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<SubmissionRecord> => {
  const { registration, competition } = await requireAccess(
    competitionId,
    registrationId,
    userId,
    db,
  );

  // Key-prefix validation BEFORE any DB write — the ownership boundary. A caller must not be able
  // to attach a key scoped to a different registration or a different competition.
  const requiredPrefix = buildSubmissionRegistrationPrefix(competitionId, registrationId);
  if (!metadata.fileKey.startsWith(requiredPrefix)) {
    throw new SubmissionError(
      "submission_invalid_file_key",
      "fileKey is not scoped to this registration",
      { details: { requiredPrefix } },
    );
  }

  if (!isSubmissionWindowOpen(competition, now)) {
    throw new SubmissionError(
      "submission_window_closed",
      "The submission window for this competition is not open",
    );
  }

  assertNotCancelled(registration);

  if (!isR2Available()) {
    throw new SubmissionError(
      "submission_upload_unavailable",
      "File storage is not configured — uploads are temporarily unavailable",
    );
  }

  // Authoritative validation, before any DB write. Throws (and deletes the offending object) when
  // the stored bytes are not an accepted format or the real size is over the ceiling.
  const confirmed = await confirmStoredFile(metadata.fileKey, metadata.fileName);

  // The key this upload replaces, if any — read before the upsert so the superseded object can be
  // reclaimed afterwards.
  const previous = await getSubmissionRow(registrationId, db);

  const [row] = await db
    .insert(competitionSubmissions)
    .values({
      registrationId,
      submittedById: userId,
      fileKey: metadata.fileKey,
      fileName: metadata.fileName,
      fileSizeBytes: confirmed.sizeBytes,
      fileMimeType: confirmed.contentType,
    })
    .onConflictDoUpdate({
      target: competitionSubmissions.registrationId,
      set: {
        submittedById: userId,
        fileKey: metadata.fileKey,
        fileName: metadata.fileName,
        fileSizeBytes: confirmed.sizeBytes,
        fileMimeType: confirmed.contentType,
        version: sql`${competitionSubmissions.version} + 1`,
        updatedAt: sql`now()`,
      },
      setWhere: isNull(competitionSubmissions.finalizedAt),
    })
    .returning();

  if (!row) {
    // Conflict matched a finalized row — the WHERE guard blocked the update and the conflict
    // blocked the insert. The submission is locked.
    throw new SubmissionError(
      "submission_finalized",
      "Submission has been finalized and is locked",
      {
        status: 422,
      },
    );
  }

  // The row now points at the new object, so the one it replaced is unreachable. Best-effort: a
  // failure here leaks one object and must not fail a submission that has already been recorded.
  if (previous && previous.fileKey !== metadata.fileKey) {
    await deleteObject(previous.fileKey).catch((err: unknown) => {
      logger.warn("submission.superseded_file.delete_failed", {
        registrationId,
        fileKey: previous.fileKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return row;
};

// Finalize (lock) a submission. The DB WHERE clause (finalized_at IS NULL) is the authority — a
// 0-row update means the row was already finalized (possibly by a concurrent request).
export const finalizeSubmission = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  db: Database = getDb(),
): Promise<SubmissionRecord> => {
  const { registration } = await requireAccess(competitionId, registrationId, userId, db);
  assertNotCancelled(registration);

  const existing = await getSubmissionRow(registrationId, db);
  if (!existing) {
    throw new SubmissionError("submission_not_found", "No submission to finalize");
  }

  const [row] = await db
    .update(competitionSubmissions)
    .set({ finalizedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(competitionSubmissions.registrationId, registrationId),
        isNull(competitionSubmissions.finalizedAt),
      ),
    )
    .returning();

  if (!row) {
    throw new SubmissionError("submission_finalized", "Submission has already been finalized");
  }

  enqueueSubmissionFinalized({
    submissionId: row.id,
    registrationId,
    studentId: userId,
    competitionId,
  }).catch((err: unknown) => {
    logger.warn("submission.finalized.enqueue_failed", {
      registrationId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return row;
};

// ── Page view-model loader ────────────────────────────────────────────────────

// The submission page route carries only the registrationId (not a competitionId). This loader
// resolves access from the registrationId alone (the competitionId cross-check does not apply —
// there is no URL competitionId to forge), surfaces the competitionId the client component needs
// for its API calls, and returns the current submission state + window status. Returns null when
// the caller cannot access the registration so the page can 404.
export type SubmissionView = {
  competitionId: string;
  competitionTitle: string;
  registrationStatus: "confirmed" | "cancelled" | "pending_payment";
  registrationType: "individual" | "team";
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  windowOpen: boolean;
  submission: SubmissionRecord | null;
};

export const getSubmissionViewForRegistration = async (
  registrationId: string,
  userId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<SubmissionView | null> => {
  const loaded = await loadRegistrationWithCompetition(registrationId, db);
  if (!loaded) {
    return null;
  }

  const allowed = await canAccessRegistration(loaded.registration, userId, db);
  if (!allowed) {
    return null;
  }

  const submission = await getSubmissionRow(registrationId, db);

  return {
    competitionId: loaded.competition.id,
    competitionTitle: loaded.competition.title,
    registrationStatus: loaded.registration.status,
    registrationType: loaded.registration.registrationType,
    eventStartAt: loaded.competition.eventStartAt,
    eventEndAt: loaded.competition.eventEndAt,
    windowOpen: isSubmissionWindowOpen(loaded.competition, now),
    submission,
  };
};

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Competitions whose event ended long enough ago that their unfinalized submissions are due to be
 * reclaimed. Ordered by nothing in particular — the caller purges each independently.
 *
 * A competition with no `event_end_at` is SKIPPED, never purged: there is no date to count from,
 * so there is no way to know the work is abandoned. Same rule as the document purge.
 */
// The instant before which a competition's event must have ended for its abandoned uploads to be
// due. Pure, so the window arithmetic is checkable on its own.
export const resolveSubmissionPurgeCutoff = (
  now: Date,
  graceDays: number = UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS,
): Date => new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

/**
 * What makes a competition due. Extracted and exported because all three conditions are
 * load-bearing and none of them is visible in the function's return value:
 *
 *   - unfinalized only, so a finalized entry is never in scope;
 *   - `event_end_at` present, so a competition with no end date is skipped rather than treated as
 *     infinitely overdue;
 *   - `event_end_at` before the cutoff.
 *
 * Dropping any one of them silently widens what gets deleted, which is the worst possible failure
 * for this feature — so the condition is asserted directly against its compiled SQL.
 */
export const buildSubmissionPurgeDueCondition = (cutoff: Date) =>
  and(
    isNull(competitionSubmissions.finalizedAt),
    isNotNull(competitions.eventEndAt),
    lt(competitions.eventEndAt, cutoff),
  );

export const listCompetitionsDueForSubmissionPurge = async (
  graceDays: number = UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ competitionId: competitionRegistrations.competitionId })
    .from(competitionSubmissions)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionSubmissions.registrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .where(buildSubmissionPurgeDueCondition(resolveSubmissionPurgeCutoff(now, graceDays)));

  return rows.map((row) => row.competitionId);
};

export type SubmissionPurgeOutcome = {
  objectsDeleted: number;
  rowsDeleted: number;
  finalizedKept: number;
};

/**
 * Reclaims one competition's abandoned submission uploads, long after its event.
 *
 * A FINALIZED submission is never touched — it is the participant's entry, the thing a published
 * result rests on, and their own creative work. This deletes only what was uploaded and never
 * submitted, plus any object under the competition's prefix that no surviving row references (an
 * upload that was PUT and never recorded at all).
 *
 * The keep-set is built from finalized rows and everything else under the prefix goes, rather than
 * deleting each unfinalized row's key. That is what catches objects the database has forgotten,
 * which is the whole reason the key layout leads with the competition — one prefix listing answers
 * "everything this competition ever stored", where a walk of the rows only answers "everything it
 * still remembers".
 *
 * Objects are deleted before rows, so a storage failure leaves rows pointing at bytes to retry
 * against rather than bytes nothing remembers.
 */
export const purgeUnfinalizedSubmissionsForCompetition = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<SubmissionPurgeOutcome> => {
  if (!isR2Available()) {
    throw new SubmissionError(
      "submission_upload_unavailable",
      "File storage is not configured — submissions cannot be purged",
    );
  }

  const rows = await db
    .select({
      registrationId: competitionSubmissions.registrationId,
      fileKey: competitionSubmissions.fileKey,
      finalizedAt: competitionSubmissions.finalizedAt,
    })
    .from(competitionSubmissions)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionSubmissions.registrationId),
    )
    .where(eq(competitionRegistrations.competitionId, competitionId));

  const finalized = rows.filter((row) => row.finalizedAt !== null);
  const unfinalized = rows.filter((row) => row.finalizedAt === null);
  const keepKeys = new Set(finalized.map((row) => row.fileKey));

  const objects = await listObjects(buildSubmissionCompetitionPrefix(competitionId));

  let objectsDeleted = 0;
  for (const object of objects) {
    if (keepKeys.has(object.key)) continue;
    await deleteObject(object.key);
    objectsDeleted += 1;
  }

  let rowsDeleted = 0;
  if (unfinalized.length > 0) {
    const deleted = await db
      .delete(competitionSubmissions)
      .where(
        inArray(
          competitionSubmissions.registrationId,
          unfinalized.map((row) => row.registrationId),
        ),
      )
      .returning({ registrationId: competitionSubmissions.registrationId });
    rowsDeleted = deleted.length;
  }

  logger.info("submission.unfinalized_purged", {
    competitionId,
    objectsDeleted,
    rowsDeleted,
    finalizedKept: finalized.length,
  });

  return { objectsDeleted, rowsDeleted, finalizedKept: finalized.length };
};
