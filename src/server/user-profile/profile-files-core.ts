// Types, limits, and validation for profile file uploads (avatar, banner, resume, certificate
// file). Client-safe (no `next/server` import) so the browser upload helper can reuse the mime/size
// rules to pre-validate before requesting an upload URL. The HTTP response mapping lives in the
// server-only route helper.

import { IMAGE_UPLOAD_MIME_TYPES } from "@/lib/media/image-frames";

export type ProfileFileKind = "avatar" | "banner" | "resume" | "certification";

// Per-kind rules. `prefix` is the R2 key namespace; the full key is server-chosen so a client can
// never forge a key scoped to another user (or another certification).
export const PROFILE_FILE_RULES: Record<
  ProfileFileKind,
  { prefix: string; maxBytes: number; mimeTypes: readonly string[] }
> = {
  avatar: {
    prefix: "avatars",
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: IMAGE_UPLOAD_MIME_TYPES,
  },
  banner: {
    prefix: "banners",
    maxBytes: 8 * 1024 * 1024,
    mimeTypes: IMAGE_UPLOAD_MIME_TYPES,
  },
  resume: {
    prefix: "resumes",
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: ["application/pdf"],
  },
  certification: {
    prefix: "profile-certifications",
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  },
};

export const PROFILE_FILE_UPLOAD_EXPIRY_SECONDS = 300;
export const PROFILE_FILE_READ_EXPIRY_SECONDS = 3600;

const MAX_FILE_NAME_LENGTH = 255;

export type ProfileFileUploadRequest = { fileName: string; mimeType: string };

export type ProfileFileMetadata = {
  fileKey: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
};

// ---------------------------------------------------------------------------
// Error type + status mapping
// ---------------------------------------------------------------------------

export type ProfileFileErrorCode =
  | "profile_file_invalid_payload"
  | "profile_file_type_not_allowed"
  | "profile_file_too_large"
  | "profile_file_invalid_key"
  | "profile_file_not_found"
  | "profile_file_unavailable";

export class ProfileFileError extends Error {
  constructor(
    public readonly code: ProfileFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const profileFileErrorStatus = (code: ProfileFileErrorCode): number => {
  if (code === "profile_file_not_found") return 404;
  if (code === "profile_file_unavailable") return 503;
  if (code === "profile_file_type_not_allowed" || code === "profile_file_too_large") return 422;
  return 400;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseFileName = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProfileFileError("profile_file_invalid_payload", "fileName is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_FILE_NAME_LENGTH) {
    throw new ProfileFileError("profile_file_invalid_payload", "fileName is too long");
  }
  return trimmed;
};

const assertMimeAllowed = (kind: ProfileFileKind, mimeType: string): void => {
  if (!PROFILE_FILE_RULES[kind].mimeTypes.includes(mimeType)) {
    throw new ProfileFileError(
      "profile_file_type_not_allowed",
      `File type ${mimeType} is not allowed for ${kind}`,
    );
  }
};

// Validates an upload-URL request. Enforces an allowed mime type so it is bound into the presigned
// PUT signature (the browser must send a matching Content-Type header).
export const parseUploadRequest = (
  kind: ProfileFileKind,
  payload: unknown,
): ProfileFileUploadRequest => {
  if (!isRecord(payload)) {
    throw new ProfileFileError("profile_file_invalid_payload", "Body must be a JSON object");
  }
  const fileName = parseFileName(payload.fileName);
  if (typeof payload.mimeType !== "string") {
    throw new ProfileFileError("profile_file_invalid_payload", "mimeType is required");
  }
  assertMimeAllowed(kind, payload.mimeType);
  return { fileName, mimeType: payload.mimeType };
};

// Validates the record payload sent after the browser has uploaded to R2. Size and mime are
// client-declared (DEC-0066 boundary — no server-side byte inspection at MVP); the key-prefix
// ownership check is applied by the service (it needs the userId / certId).
export const parseFileMetadata = (kind: ProfileFileKind, payload: unknown): ProfileFileMetadata => {
  if (!isRecord(payload)) {
    throw new ProfileFileError("profile_file_invalid_payload", "Body must be a JSON object");
  }
  if (typeof payload.fileKey !== "string" || payload.fileKey.trim().length === 0) {
    throw new ProfileFileError("profile_file_invalid_payload", "fileKey is required");
  }
  const fileName = parseFileName(payload.fileName);
  if (typeof payload.mimeType !== "string") {
    throw new ProfileFileError("profile_file_invalid_payload", "mimeType is required");
  }
  assertMimeAllowed(kind, payload.mimeType);
  if (
    typeof payload.sizeBytes !== "number" ||
    !Number.isInteger(payload.sizeBytes) ||
    payload.sizeBytes <= 0
  ) {
    throw new ProfileFileError(
      "profile_file_invalid_payload",
      "sizeBytes must be a positive integer",
    );
  }
  if (payload.sizeBytes > PROFILE_FILE_RULES[kind].maxBytes) {
    throw new ProfileFileError("profile_file_too_large", "File exceeds the maximum allowed size");
  }
  return {
    fileKey: payload.fileKey,
    fileName,
    sizeBytes: payload.sizeBytes,
    mimeType: payload.mimeType,
  };
};
