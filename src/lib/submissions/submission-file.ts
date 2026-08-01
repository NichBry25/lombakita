// Competition submission upload rules — the allowlist, size ceiling, and filename helpers.
//
// Client-safe (no server imports) so the submission form can pre-validate a chosen file using
// exactly the rules the server enforces. The server treats these as advisory at presign time (the
// client controls the declared values) and authoritative at record time, where they are re-checked
// against the object's real size and its magic-byte-detected type.
//
// This allowlist is deliberately WIDER than the identity-document one
// (@/lib/recruiter-verification/verification-document): a competition entry is legitimately a
// slide deck, a spreadsheet, a rendered video, or a zip of source code, where an identity document
// is only ever a scan. It is not a superset in spirit — the same rule holds, that every accepted
// format has a magic-byte signature the server can confirm.

export const SUBMISSION_MAX_BYTES = 50 * 1024 * 1024;

// The byte-level format a file actually is. Several accepted extensions share one of these —
// every OOXML Office file is a zip container — so this is the family the signature confirms, not
// the specific format.
export const SUBMISSION_FILE_FAMILIES = [
  "application/pdf",
  "application/zip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
] as const;

export type SubmissionFileFamily = (typeof SUBMISSION_FILE_FAMILIES)[number];

type SubmissionFormat = {
  // The content type stored and served for this extension. May be more specific than the family
  // (a .docx is stored as the Word type) — safe because the family beneath it is byte-confirmed.
  mimeType: string;
  // The signature family the bytes must match for this extension to be accepted.
  family: SubmissionFileFamily;
};

// Extension → format table. An extension not listed here is refused outright; there is no
// "unknown binary" fallback, because a format with no signature cannot be confirmed and would
// reduce the check to trusting the client.
const FORMAT_BY_EXTENSION: Record<string, SubmissionFormat> = {
  pdf: { mimeType: "application/pdf", family: "application/pdf" },
  zip: { mimeType: "application/zip", family: "application/zip" },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    family: "application/zip",
  },
  pptx: {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    family: "application/zip",
  },
  xlsx: {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    family: "application/zip",
  },
  jpg: { mimeType: "image/jpeg", family: "image/jpeg" },
  jpeg: { mimeType: "image/jpeg", family: "image/jpeg" },
  png: { mimeType: "image/png", family: "image/png" },
  webp: { mimeType: "image/webp", family: "image/webp" },
  gif: { mimeType: "image/gif", family: "image/gif" },
  mp4: { mimeType: "video/mp4", family: "video/mp4" },
};

export const SUBMISSION_ALLOWED_EXTENSIONS = Object.keys(FORMAT_BY_EXTENSION);

// `accept` attribute for the file input. A convenience for the picker only — it filters the OS
// dialog and is trivially bypassed, so it is never the enforcement.
export const SUBMISSION_ACCEPT_ATTRIBUTE = SUBMISSION_ALLOWED_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

// Human-readable format list for form copy, so the UI never drifts from the table above.
export const SUBMISSION_FORMAT_HINT = SUBMISSION_ALLOWED_EXTENSIONS.map((extension) =>
  extension.toUpperCase(),
).join(", ");

// Lowercased extension without the dot, or "" when the name has none.
export const getSubmissionFileExtension = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
};

export const submissionFormatForFileName = (fileName: string): SubmissionFormat | null =>
  FORMAT_BY_EXTENSION[getSubmissionFileExtension(fileName)] ?? null;

// The content type to declare at presign and store after the bytes are confirmed. Derived from
// the filename, never from the browser's own `file.type`, which is empty for many formats and
// client-controlled in every case.
export const submissionMimeTypeForFileName = (fileName: string): string | null =>
  submissionFormatForFileName(fileName)?.mimeType ?? null;

// True when the filename's extension belongs to the signature family the bytes were detected as.
// This is what stops a `.pdf` carrying zip bytes, while still accepting every OOXML extension for
// one zip signature.
export const familyMatchesFileName = (fileName: string, family: SubmissionFileFamily): boolean =>
  submissionFormatForFileName(fileName)?.family === family;

const formatMegabytes = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
};

/**
 * Client-side pre-validation of a chosen file. Returns a localized message when the file is not
 * acceptable, or null when it passes the extension and size rules. The authoritative check is the
 * server's byte inspection at record time; this only spares the candidate a failed upload.
 */
export const preValidateSubmissionFile = (file: { name: string; size: number }): string | null => {
  if (submissionFormatForFileName(file.name) === null) {
    return `Format tidak didukung. Unggah ${SUBMISSION_FORMAT_HINT}, atau kemas berkas Anda sebagai ZIP.`;
  }
  if (file.size > SUBMISSION_MAX_BYTES) {
    return `Ukuran berkas melebihi ${formatMegabytes(SUBMISSION_MAX_BYTES)}.`;
  }
  if (file.size === 0) {
    return "Berkas kosong. Pilih berkas lain.";
  }
  return null;
};
