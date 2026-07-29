// Pure validation for participant document requests. No database access and no session handling —
// every function here takes a payload and returns a parsed value or throws.

import { NextResponse } from "next/server";

export const MAX_REQUEST_TITLE_LENGTH = 160;
export const MAX_REQUEST_INSTRUCTIONS_LENGTH = 2000;
export const MAX_REVIEW_NOTE_LENGTH = 2000;
// Bounds a single batch so one request cannot fan out into an unbounded write.
export const MAX_BATCH_REGISTRATIONS = 200;

// How long a competition's identity documents are kept after its event ends.
//
// These are students' ID cards — the most sensitive data the platform holds — so they are kept
// only while they can still be needed, not indefinitely. Ninety days covers a prize dispute
// surfacing well after the ceremony while keeping the retained set small. Storage cost is not the
// consideration; the exposure of holding a growing archive of identity documents is.
export const DOCUMENT_RETENTION_GRACE_DAYS = 90;

export type RegistrationDocumentErrorCode =
  | "document_request_invalid_payload"
  | "document_request_invalid_value"
  | "document_request_not_found"
  | "document_request_already_open"
  | "document_request_wrong_status"
  | "document_request_file_not_found"
  | "document_request_file_invalid"
  | "document_request_file_too_large"
  | "document_request_file_type_not_allowed"
  | "document_request_storage_unavailable";

export class RegistrationDocumentError extends Error {
  constructor(
    public readonly code: RegistrationDocumentErrorCode,
    public readonly httpStatus: 400 | 404 | 409 | 422 | 503,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RegistrationDocumentError";
  }
}

export const toRegistrationDocumentErrorResponse = (
  error: RegistrationDocumentError,
): NextResponse =>
  NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    { status: error.httpStatus },
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidValue = (message: string, field: string): never => {
  throw new RegistrationDocumentError("document_request_invalid_value", 422, message, {
    fields: [field],
  });
};

const requireObject = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) {
    throw new RegistrationDocumentError(
      "document_request_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }
  return payload;
};

const parseRequiredText = (field: string, value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return invalidValue(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalidValue(`${field} is required`, field);
  if (trimmed.length > maxLength) {
    return invalidValue(`${field} must be ${maxLength} characters or fewer`, field);
  }
  return trimmed;
};

const parseOptionalText = (field: string, value: unknown, maxLength: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return invalidValue(`${field} must be a string or null`, field);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    return invalidValue(`${field} must be ${maxLength} characters or fewer`, field);
  }
  return trimmed;
};

// A deadline must be a real datetime in the future. A past deadline would be born lapsed, which
// reads to the candidate as an instruction they have already failed.
const parseFutureDate = (field: string, value: unknown, now: Date): Date => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidValue(`${field} must be a datetime string`, field);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return invalidValue(`${field} is not a valid datetime`, field);
  }
  if (parsed.getTime() <= now.getTime()) {
    return invalidValue(`${field} must be in the future`, field);
  }
  return parsed;
};

export type DocumentRequestInput = {
  title: string;
  instructions: string | null;
  dueAt: Date;
};

export const parseDocumentRequestInput = (
  payload: unknown,
  now: Date = new Date(),
): DocumentRequestInput => {
  const body = requireObject(payload);
  return {
    title: parseRequiredText("title", body.title, MAX_REQUEST_TITLE_LENGTH),
    instructions: parseOptionalText(
      "instructions",
      body.instructions,
      MAX_REQUEST_INSTRUCTIONS_LENGTH,
    ),
    dueAt: parseFutureDate("dueAt", body.dueAt, now),
  };
};

export type BatchDocumentRequestInput = DocumentRequestInput & {
  registrationIds: string[];
};

export const parseBatchDocumentRequestInput = (
  payload: unknown,
  now: Date = new Date(),
): BatchDocumentRequestInput => {
  const body = requireObject(payload);
  const raw = body.registrationIds;

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RegistrationDocumentError(
      "document_request_invalid_payload",
      400,
      "registrationIds must be a non-empty array",
    );
  }
  if (raw.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    invalidValue("registrationIds must contain only non-empty strings", "registrationIds");
  }
  if (raw.length > MAX_BATCH_REGISTRATIONS) {
    invalidValue(
      `A batch may target at most ${MAX_BATCH_REGISTRATIONS} participants`,
      "registrationIds",
    );
  }

  // De-duplicated so the same participant named twice produces one request rather than a
  // self-collision against the one-open-request guard.
  const registrationIds = Array.from(new Set(raw as string[]));

  return { ...parseDocumentRequestInput(body, now), registrationIds };
};

// The verdict on a submitted document, or on a request that was never answered.
//
// `reject` carries the re-upload bar. It defaults to allowing another attempt because the most
// common rejection is a photo that cannot be read rather than a document that is untrue — but the
// organizer may close it outright, which is what a zero-tolerance policy needs. When another
// attempt is allowed, a fresh deadline comes with it: reopening a request against an expired
// deadline would hand the candidate a task that is already late.
export type DocumentReviewInput =
  | { verdict: "accept"; note: string | null }
  | { verdict: "reject"; note: string; allowReupload: false }
  | { verdict: "reject"; note: string; allowReupload: true; dueAt: Date };

export const parseDocumentReviewInput = (
  payload: unknown,
  now: Date = new Date(),
): DocumentReviewInput => {
  const body = requireObject(payload);
  const verdict = body.verdict;

  if (verdict === "accept") {
    return {
      verdict: "accept",
      note: parseOptionalText("note", body.note, MAX_REVIEW_NOTE_LENGTH),
    };
  }

  if (verdict !== "reject") {
    return invalidValue("verdict must be either accept or reject", "verdict");
  }

  // A rejection always states a reason. The candidate sees it as page content, and without one
  // they are left with a refusal and no way to act on it.
  const note = parseRequiredText("note", body.note, MAX_REVIEW_NOTE_LENGTH);

  if (body.allowReupload === false) {
    return { verdict: "reject", note, allowReupload: false };
  }
  if (body.allowReupload !== true) {
    return invalidValue("allowReupload must be a boolean", "allowReupload");
  }

  return {
    verdict: "reject",
    note,
    allowReupload: true,
    dueAt: parseFutureDate("dueAt", body.dueAt, now),
  };
};

export const parseDeadlineExtensionInput = (payload: unknown, now: Date = new Date()): Date => {
  const body = requireObject(payload);
  return parseFutureDate("dueAt", body.dueAt, now);
};

export type DocumentFileDeclaration = {
  originalFileName: string;
  contentType: string;
  fileSizeBytes: number;
};

export const parseDocumentFileDeclaration = (payload: unknown): DocumentFileDeclaration => {
  const body = requireObject(payload);
  const fileSizeBytes = body.fileSizeBytes;

  if (typeof fileSizeBytes !== "number" || !Number.isFinite(fileSizeBytes)) {
    invalidValue("fileSizeBytes must be a number", "fileSizeBytes");
  }

  return {
    originalFileName: parseRequiredText("originalFileName", body.originalFileName, 255),
    contentType: parseRequiredText("contentType", body.contentType, 255),
    fileSizeBytes: fileSizeBytes as number,
  };
};

export type DocumentFileFinalizeInput = {
  r2Key: string;
  originalFileName: string;
};

export const parseDocumentFileFinalizeInput = (payload: unknown): DocumentFileFinalizeInput => {
  const body = requireObject(payload);
  return {
    r2Key: parseRequiredText("r2Key", body.r2Key, 1024),
    originalFileName: parseRequiredText("originalFileName", body.originalFileName, 255),
  };
};

// Storage key layout: registration-documents/{competitionId}/{registrationId}/{requestId}/{uuid}.
//
// Two jobs, which is why the competition sits at the front even though nothing in the upload path
// needs it there:
//
//   1. Ownership boundary. A key that does not start with the prefix built from the request the
//      caller actually owns is refused before anything touches storage.
//   2. Retention. These are identity documents, and the retention unit is the competition — once
//      it is over and nothing is outstanding, everything it collected goes. Leading with the
//      competition makes that a single prefix listing rather than a walk through three tables, and
//      it sweeps abandoned uploads that no row ever referenced along with the rest.
//
// The competition segment is load-bearing for (2) and must not be dropped: without it a purge can
// only delete what the database still remembers.
export const buildRequestObjectPrefix = (
  competitionId: string,
  registrationId: string,
  requestId: string,
): string => `registration-documents/${competitionId}/${registrationId}/${requestId}/`;

// Everything one competition ever collected. The retention purge deletes this whole subtree.
export const buildCompetitionObjectPrefix = (competitionId: string): string =>
  `registration-documents/${competitionId}/`;
