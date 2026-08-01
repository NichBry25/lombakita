// The organizer's read access to a participant's submitted work.
//
// Candidates have been able to upload submissions to R2 since Step 4.6, but nothing ever read
// them back: `resolveSubmissionAccess` (submission-service.ts) grants only the registrant and
// their active teammates, so a committee could see that a file existed and never open it. This
// module is the institution-scoped counterpart — metadata for the review page, and a short-lived
// presigned GET for the file itself.
//
// Access is gated at the route layer via requireAdminInstitutionBySlug; this service additionally
// enforces competition ownership, so a registrationId belonging to another institution collapses
// to a 404 with no information leak (same pattern as review-service.ts and participant-service.ts).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  competitionRegistrations,
  competitionSubmissions,
  institutionAuditLogs,
  teams,
  users,
  userProfiles,
} from "@/server/db/schema";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";
import {
  buildContentDisposition,
  sanitizeFileName,
} from "@/lib/recruiter-verification/verification-document";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/participants/submission-file-service");

export type SubmissionFileErrorCode = "submission_not_found" | "submission_download_unavailable";

export class SubmissionFileError extends Error {
  constructor(
    public readonly code: SubmissionFileErrorCode,
    public readonly httpStatus: 404 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SubmissionFileError";
  }
}

export const toSubmissionFileErrorResponse = (error: SubmissionFileError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.httpStatus },
  );

// Presigned GET lifetime — 5 minutes, matching the recruiter-verification and
// registration-document read paths. Long enough to open a tab, short enough that a copied URL
// is not a durable handout.
const PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = 300;

// Content types the organizer's browser may render in a tab.
//
// The stored `file_mime_type` is CLIENT-DECLARED — the submission upload path has no magic-byte
// inspection (unlike the DEC-0111 document pipeline), so a candidate can upload anything and
// label it anything. Binding the served Content-Type to a value from this set is what makes an
// inline render safe: a file claiming to be a PDF renders through the PDF viewer and fails, it
// does not execute. `text/html` and `image/svg+xml` are deliberately absent — both are scriptable
// in a top-level tab, which would turn a submission upload into stored XSS on the bucket origin.
const INLINE_RENDERABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Anything not inline-renderable is served as an opaque download. The browser saves the bytes and
// never interprets them, so an archive, an Office document, a video, or an unrecognised type
// carries no render-time risk regardless of what the candidate declared it to be.
const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

export type InstitutionSubmissionView = {
  fileName: string;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
  version: number;
  finalized: boolean;
  submittedAt: string;
  // False when the file must be downloaded rather than opened in a tab, so the UI can offer only
  // the control that will actually work.
  canRenderInline: boolean;
};

type SubmissionRow = {
  fileKey: string;
  fileName: string;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
  version: number;
  finalizedAt: Date | null;
  submittedAt: Date;
  participantDisplayName: string | null;
  participantUsername: string | null;
  teamName: string | null;
};

// Loads the submission for a registration the given institution owns. A registration under a
// different institution, a competitionId that does not own the registration, or a registration
// with no submission all return null — one path, so the caller cannot distinguish them.
const loadOwnedSubmission = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  db: Database,
): Promise<SubmissionRow | null> => {
  const [row] = await db
    .select({
      fileKey: competitionSubmissions.fileKey,
      fileName: competitionSubmissions.fileName,
      fileSizeBytes: competitionSubmissions.fileSizeBytes,
      fileMimeType: competitionSubmissions.fileMimeType,
      version: competitionSubmissions.version,
      finalizedAt: competitionSubmissions.finalizedAt,
      submittedAt: competitionSubmissions.submittedAt,
      participantDisplayName: userProfiles.displayName,
      participantUsername: users.username,
      teamName: teams.name,
    })
    .from(competitionSubmissions)
    .innerJoin(
      competitionRegistrations,
      eq(competitionRegistrations.id, competitionSubmissions.registrationId),
    )
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .leftJoin(users, eq(users.id, competitionRegistrations.studentId))
    .leftJoin(userProfiles, eq(userProfiles.userId, competitionRegistrations.studentId))
    .leftJoin(teams, eq(teams.id, competitionRegistrations.teamId))
    .where(
      and(
        eq(competitionSubmissions.registrationId, registrationId),
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitions.institutionId, institutionId),
      ),
    )
    .limit(1);

  return row ?? null;
};

// Returns the normalized content type to bind when a file may be rendered in a tab, or null when
// it may not. Returning the value rather than a boolean keeps the served type and the decision to
// serve inline from ever drifting apart.
const inlineContentType = (mimeType: string | null): string | null => {
  if (mimeType == null) return null;
  const normalized = mimeType.trim().toLowerCase();
  return INLINE_RENDERABLE_CONTENT_TYPES.has(normalized) ? normalized : null;
};

/**
 * Reads the submission attached to one registration, for an organizer who owns the competition.
 *
 * Returns null when the institution does not own the registration or when nothing has been
 * submitted yet — the review page renders the same "no submission" state for both.
 */
export const getSubmissionForInstitution = async (
  institutionId: string,
  competitionId: string,
  registrationId: string,
  db: Database = getDb(),
): Promise<InstitutionSubmissionView | null> => {
  const row = await loadOwnedSubmission(institutionId, competitionId, registrationId, db);
  if (!row) return null;

  return {
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes,
    fileMimeType: row.fileMimeType,
    version: row.version,
    finalized: row.finalizedAt != null,
    submittedAt: row.submittedAt.toISOString(),
    canRenderInline: inlineContentType(row.fileMimeType) !== null,
  };
};

// Download filename: `<participant>_<original file name>`. An organizer working through a
// competition downloads many files into one folder, and the candidate's own filename is often
// "final.pdf". Both parts are sanitized before reaching the header.
const buildDownloadName = (row: SubmissionRow): string => {
  const participant =
    row.teamName ?? row.participantDisplayName ?? row.participantUsername ?? "peserta";
  return `${sanitizeFileName(participant)}_${sanitizeFileName(row.fileName)}`;
};

/**
 * Mints a short-lived presigned GET for a participant's submitted file.
 *
 * The access is audited. This follows the DEC-0121 precedent for organizer document reads: the
 * audit row is written BEFORE the URL is minted, so a storage failure cannot produce an
 * unrecorded read. A submission is a candidate's own work and often unpublished, so "who
 * downloaded this entry, and when" has to stay answerable.
 *
 * `inline` is honoured only for a content type this app is willing to render in a tab; everything
 * else is forced to an attachment download with an opaque content type. The caller's requested
 * disposition is therefore a preference, not a command — see INLINE_RENDERABLE_CONTENT_TYPES.
 */
export const resolveSubmissionFileUrlForInstitution = async (
  institutionId: string,
  actorUserId: string,
  competitionId: string,
  registrationId: string,
  requestedDisposition: "inline" | "attachment",
  db: Database = getDb(),
): Promise<{ url: string; disposition: "inline" | "attachment" }> => {
  const row = await loadOwnedSubmission(institutionId, competitionId, registrationId, db);
  if (!row) {
    throw new SubmissionFileError("submission_not_found", 404, "Submission not found");
  }

  if (!isR2Available()) {
    throw new SubmissionFileError(
      "submission_download_unavailable",
      503,
      "File storage is not configured — submission downloads are temporarily unavailable",
    );
  }

  const renderableType =
    requestedDisposition === "inline" ? inlineContentType(row.fileMimeType) : null;
  const disposition: "inline" | "attachment" = renderableType ? "inline" : "attachment";
  const contentType = renderableType ?? DOWNLOAD_CONTENT_TYPE;
  const fileName = renderableType ? sanitizeFileName(row.fileName) : buildDownloadName(row);

  await db.insert(institutionAuditLogs).values({
    institutionId,
    actorUserId,
    action: "submission.file_accessed",
    metadata: {
      competitionId,
      registrationId,
      fileName: row.fileName,
      version: row.version,
      disposition,
    },
  });

  const url = await generatePresignedGetUrl(row.fileKey, PRESIGNED_DOWNLOAD_EXPIRY_SECONDS, {
    responseContentType: contentType,
    responseContentDisposition: buildContentDisposition(disposition, fileName),
  });

  return { url, disposition };
};
