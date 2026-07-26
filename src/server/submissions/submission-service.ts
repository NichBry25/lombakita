import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/submissions/submission-service");

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitions,
  competitionSubmissions,
  teamMemberships,
  type SubmissionRecord,
} from "@/server/db/schema";
import { generatePresignedPutUrl, isR2Available } from "@/server/storage/r2.client";
import {
  isSubmissionWindowOpen,
  SubmissionError,
  type ValidatedFileMetadata,
} from "@/server/submissions/submission-core";
import {
  SUBMISSIONS_KEY_PREFIX,
  SUBMISSIONS_UPLOAD_EXPIRY_SECONDS,
} from "@/server/submissions/submission-constants";
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
};

// Mint a presigned PUT URL the browser uses to upload a file directly to R2. The generated key is
// `submissions/{registrationId}/{uuid}` — the candidate cannot choose the key, so it is always
// correctly scoped. Degrades to a 503 (submission_upload_unavailable), never a 500, when R2 is
// not configured.
export const generateSubmissionUploadUrl = async (
  competitionId: string,
  registrationId: string,
  userId: string,
  input: { fileName: string; fileMimeType: string | null },
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

  const fileKey = `${SUBMISSIONS_KEY_PREFIX}/${registrationId}/${randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    fileKey,
    input.fileMimeType,
    SUBMISSIONS_UPLOAD_EXPIRY_SECONDS,
  );
  const expiresAt = new Date(now.getTime() + SUBMISSIONS_UPLOAD_EXPIRY_SECONDS * 1000);

  return { uploadUrl, fileKey, expiresAt };
};

// Record (create) or replace submission metadata after the file has been uploaded to R2.
// Replace semantics: an UPSERT on registration_id. The finalized guard lives in the DB WHERE
// clause of the conflict update (setWhere: finalized_at IS NULL) — NOT a read-before-write check
// — so a finalized row cannot be overwritten even under a concurrent race. When the conflict
// update matches no row (the existing submission is finalized), the upsert returns nothing and we
// raise submission_finalized. On insert, version starts at 1; on replace, version increments by 1
// and finalized_at is left untouched (still null by the WHERE guard).
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

  // Key-prefix validation BEFORE any DB write — the MVP security boundary. A caller must not be
  // able to attach a key scoped to a different registration.
  const requiredPrefix = `${SUBMISSIONS_KEY_PREFIX}/${registrationId}/`;
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

  const [row] = await db
    .insert(competitionSubmissions)
    .values({
      registrationId,
      submittedById: userId,
      fileKey: metadata.fileKey,
      fileName: metadata.fileName,
      fileSizeBytes: metadata.fileSizeBytes,
      fileMimeType: metadata.fileMimeType,
    })
    .onConflictDoUpdate({
      target: competitionSubmissions.registrationId,
      set: {
        submittedById: userId,
        fileKey: metadata.fileKey,
        fileName: metadata.fileName,
        fileSizeBytes: metadata.fileSizeBytes,
        fileMimeType: metadata.fileMimeType,
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
