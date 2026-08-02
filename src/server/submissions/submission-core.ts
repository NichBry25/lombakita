import { NextResponse } from "next/server";
import { SUBMISSIONS_MAX_FILE_SIZE_BYTES } from "@/server/submissions/submission-constants";

// Competition submission intake error codes.
// Each maps to a specific failure in the upload-url / record / finalize / read chain.
//
// `submission_invalid_payload` — body/metadata is malformed (non-object, blank fileName, wrong
//   field types, or file size over the ceiling). Body-level 400.
// `submission_invalid_file_key` — the fileKey is blank, or its prefix does not scope to the
//   target registration (`submissions/{registrationId}/...`). The prefix check is the MVP
//   security boundary; we never verify the object actually exists in R2.
// `submission_registration_not_found` — the registration row does not exist, the URL
//   competitionId does not match the registration's competition (cross-competition IDOR), or the
//   caller is not the individual owner / an active team member. All access failures collapse to
//   this single 404 so the surface never leaks whether a registration exists. (See
//   `submission_access_denied` note below.)
// `submission_access_denied` — reserved. Kept in the union for contract completeness; the
//   no-info-leak access resolver collapses every access failure to
//   `submission_registration_not_found` (404) instead, so this code is not thrown at this step.
// `submission_invalid_file_type` — the file is not an accepted format. Raised advisorily at
//   presign (from the declared filename) and authoritatively at record time, where the stored
//   object's magic-byte family must match the extension and the real size must be within the
//   ceiling. A file rejected here is deleted from R2 and no row is written.
// `submission_file_missing` — the record step ran against a key with no object behind it: the
//   browser's PUT never completed, or the presigned URL expired before it did.
export type SubmissionErrorCode =
  | "submission_not_found"
  | "submission_window_closed"
  | "submission_finalized"
  | "submission_registration_cancelled"
  | "submission_registration_not_found"
  | "submission_upload_unavailable"
  | "submission_invalid_file_key"
  | "submission_invalid_payload"
  | "submission_invalid_file_type"
  | "submission_file_missing"
  | "submission_access_denied";

// Default HTTP status per code. The `submission_finalized` default is 409 (conflict — the row is
// locked); the PUT replace path overrides it to 422 at the throw site to match the contract,
// which is why `SubmissionError` accepts a per-throw status override. Same-code/different-status
// divergence across routes follows the accepted 2.4-D1 precedent.
const STATUS_BY_CODE: Record<SubmissionErrorCode, number> = {
  submission_not_found: 404,
  submission_window_closed: 422,
  submission_finalized: 409,
  submission_registration_cancelled: 409,
  submission_registration_not_found: 404,
  submission_upload_unavailable: 503,
  submission_invalid_file_key: 422,
  submission_invalid_payload: 400,
  submission_invalid_file_type: 422,
  submission_file_missing: 422,
  submission_access_denied: 403,
};

export class SubmissionError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    public readonly code: SubmissionErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
  }
}

export const toSubmissionErrorResponse = (error: SubmissionError): NextResponse => {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    },
    { status: error.status },
  );
};

// Validated, normalized file metadata accepted by the record/replace path.
//
// There is no declared content type here on purpose: the type that gets stored is derived from
// the filename and confirmed against the object's magic bytes, so a client-supplied MIME has
// nothing to contribute. `fileSizeBytes` survives only as a cheap early rejection — the size that
// is persisted is the one read back from R2.
export type ValidatedFileMetadata = {
  fileKey: string;
  fileName: string;
  fileSizeBytes: number | null;
};

// Submission window is derived from the competition's event dates: eventStartAt <= now <=
// eventEndAt (both bounds inclusive). Returns false when either date is null — an unscheduled
// competition has no open window. now defaults to the current server time; callers never pass a
// client-supplied clock.
export const isSubmissionWindowOpen = (
  competition: { eventStartAt: Date | null; eventEndAt: Date | null },
  now: Date = new Date(),
): boolean => {
  if (!competition.eventStartAt || !competition.eventEndAt) {
    return false;
  }

  const t = now.getTime();
  return t >= competition.eventStartAt.getTime() && t <= competition.eventEndAt.getTime();
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// Parse and normalize the client-supplied file metadata. Returns a SubmissionError (not throws)
// so callers can decide how to surface it. fileKey and fileName are trimmed and must be
// non-blank; fileSizeBytes, when present, must be a non-negative integer within the size ceiling.
// A `fileMimeType` key is accepted and ignored rather than rejected, so an older client sending
// one is not broken by its removal.
export const parseSubmissionFileMetadata = (
  input: unknown,
): ValidatedFileMetadata | SubmissionError => {
  if (!isRecord(input)) {
    return new SubmissionError(
      "submission_invalid_payload",
      "Submission metadata must be an object",
    );
  }

  const { fileKey, fileName, fileSizeBytes } = input;

  if (typeof fileKey !== "string" || fileKey.trim().length === 0) {
    return new SubmissionError("submission_invalid_file_key", "fileKey is required");
  }

  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    return new SubmissionError("submission_invalid_payload", "fileName is required");
  }

  let normalizedSize: number | null = null;
  if (fileSizeBytes !== undefined && fileSizeBytes !== null) {
    if (
      typeof fileSizeBytes !== "number" ||
      !Number.isInteger(fileSizeBytes) ||
      fileSizeBytes < 0
    ) {
      return new SubmissionError(
        "submission_invalid_payload",
        "fileSizeBytes must be a non-negative integer",
      );
    }
    if (fileSizeBytes > SUBMISSIONS_MAX_FILE_SIZE_BYTES) {
      return new SubmissionError(
        "submission_invalid_payload",
        "fileSizeBytes exceeds maximum size",
        {
          details: { maxBytes: SUBMISSIONS_MAX_FILE_SIZE_BYTES },
        },
      );
    }
    normalizedSize = fileSizeBytes;
  }

  return {
    fileKey: fileKey.trim(),
    fileName: fileName.trim(),
    fileSizeBytes: normalizedSize,
  };
};
