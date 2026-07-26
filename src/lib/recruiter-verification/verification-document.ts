// Affiliation-proof document rules — the upload-security allowlist and filename helpers.
// Client-safe (no `next/server` import) so the recruiter dashboard can pre-validate a selected
// file before requesting an upload URL, using exactly the same rules the server enforces. The
// server treats these as advisory at presign time (the client controls the declared values) and
// authoritative at finalize time, where the rules are re-checked against the object's real size
// and its magic-byte-detected type.

export const VERIFICATION_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

// Allowed content types. Every entry is safe to render inline in a browser tab (PDF and raster
// images); executable and markup types (SVG, HTML, scripts) are intentionally excluded.
export const VERIFICATION_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type VerificationDocumentMimeType = (typeof VERIFICATION_DOCUMENT_MIME_TYPES)[number];

// Extension ↔ MIME agreement table. A file passes only when its extension and its detected content
// type point at the same format, so a `.pdf` carrying JPEG bytes (or vice versa) is rejected.
const MIME_BY_EXTENSION: Record<string, VerificationDocumentMimeType> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export const isAllowedDocumentMimeType = (
  mimeType: string,
): mimeType is VerificationDocumentMimeType => {
  return (VERIFICATION_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType);
};

// Lowercased extension without the dot, or "" when the name has none.
export const getFileExtension = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
};

export const mimeTypeForExtension = (extension: string): VerificationDocumentMimeType | null => {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? null;
};

// True when the filename's extension names the same format as the detected MIME type.
export const extensionMatchesMimeType = (
  fileName: string,
  mimeType: VerificationDocumentMimeType,
): boolean => {
  return mimeTypeForExtension(getFileExtension(fileName)) === mimeType;
};

// Strips path components and characters unsafe in a filename or an HTTP header, collapsing runs of
// replaced characters. Preserves the extension. Never returns an empty string.
export const sanitizeFileName = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f"'`\\/:*?<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|_+$/g, "")
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "dokumen";
};

// Download filename: `<username>_verification_<original file name>`. Both parts are sanitized so
// the value is safe to place in a Content-Disposition header. Falls back to "rekruter" when the
// submitter has no username.
export const formatVerificationDownloadName = (
  username: string | null,
  originalFileName: string,
): string => {
  const safeUser = sanitizeFileName(username ?? "rekruter");
  const safeName = sanitizeFileName(originalFileName);
  return `${safeUser}_verification_${safeName}`;
};

// Builds a Content-Disposition value with an ASCII fallback plus an RFC 5987 UTF-8 form, so
// non-ASCII filenames survive without allowing header injection.
export const buildContentDisposition = (
  mode: "inline" | "attachment",
  fileName: string,
): string => {
  const safe = sanitizeFileName(fileName);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
};

// Client-side pre-validation of a selected file. Returns a localized error message when the file
// is not acceptable, or null when it passes the extension/type/size rules. The authoritative check
// is the server finalize step; this only spares the user a round-trip.
export const preValidateVerificationDocument = (file: {
  name: string;
  type: string;
  size: number;
}): string | null => {
  const extension = getFileExtension(file.name);
  const mimeForExtension = mimeTypeForExtension(extension);
  if (!mimeForExtension) {
    return "Format tidak didukung. Unggah PDF, JPG, PNG, atau WebP.";
  }
  if (file.type && isAllowedDocumentMimeType(file.type) && file.type !== mimeForExtension) {
    return "Tipe berkas tidak cocok dengan ekstensinya.";
  }
  if (file.size <= 0) {
    return "Berkas kosong.";
  }
  if (file.size > VERIFICATION_DOCUMENT_MAX_BYTES) {
    return "Ukuran berkas melebihi batas 10 MB.";
  }
  return null;
};
