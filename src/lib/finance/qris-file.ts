// What an institution may upload as its QRIS code.
//
// Client-safe: no imports, so the form and the server share one definition of "acceptable" rather
// than drifting apart.
//
// NARROWER THAN THE TWO NEIGHBOURING RULES ON PURPOSE, which is why this is not a reuse of either.
// `payment-proof-file.ts` and `recruiter-verification/verification-document.ts` both accept PDF,
// correctly — a receipt or a legal document is something a human opens and reads. A QRIS is
// something a phone camera points at, rendered inline in an <img>, and a PDF cannot be. Accepting
// one here would produce a payment page showing a broken image where the payment method should be,
// and the institution would have no way to tell from the upload that anything was wrong.

export const QRIS_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type QrisMimeType = (typeof QRIS_MIME_TYPES)[number];

const MIME_BY_EXTENSION: Record<string, QrisMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Shown in the upload control and in the refusal, so both name the same set. */
export const QRIS_FORMAT_HINT = "PNG, JPG, atau WEBP";

// A QRIS is a screenshot or an export from a payment provider; anything larger than this is a photo
// of a screen, which scans poorly and is worth refusing at upload rather than at the till.
export const QRIS_MAX_BYTES = 5 * 1024 * 1024;

/** The MIME type for a file name, or null when the extension is not an accepted image. */
export const qrisMimeTypeForFileName = (fileName: string): QrisMimeType | null => {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
};
