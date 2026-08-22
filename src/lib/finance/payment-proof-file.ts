// WHAT COUNTS AS A BUKTI TRANSFER FILE.
//
// A deliberately NARROWER list than `submission-file.ts`, and not a reuse of it. A competition
// submission can legitimately be a ZIP or an MP4; a transfer receipt is a photo or a PDF from a
// banking app and nothing else. Widening this to the submission list would accept an archive as
// proof of payment, which an organiser cannot review and which is the shape a malicious upload
// takes when the reviewer is a human opening files.
//
// The two modules share a structure on purpose (extension table, derived MIME, client-side
// pre-validation with localized copy) so a reader who knows one knows the other. They share no
// data, because their answers differ.

type PaymentProofFormat = {
  mimeType: string;
};

const FORMAT_BY_EXTENSION: Record<string, PaymentProofFormat> = {
  pdf: { mimeType: "application/pdf" },
  jpg: { mimeType: "image/jpeg" },
  jpeg: { mimeType: "image/jpeg" },
  png: { mimeType: "image/png" },
  webp: { mimeType: "image/webp" },
};

export const PAYMENT_PROOF_ALLOWED_EXTENSIONS = Object.keys(FORMAT_BY_EXTENSION);

/**
 * Ten megabytes.
 *
 * A phone photograph of a bank receipt is one to four megabytes; a PDF statement is well under one.
 * Ten leaves room for a high-resolution capture without letting the bucket absorb a video someone
 * renamed to `.jpg`. The extension check would pass it, and only the size cap catches it before
 * the bytes are inspected.
 */
export const PAYMENT_PROOF_MAX_BYTES = 10 * 1024 * 1024;

// `accept` attribute for the file input. A convenience for the picker only: it filters the OS
// dialog and is trivially bypassed, so it is never the enforcement.
export const PAYMENT_PROOF_ACCEPT_ATTRIBUTE = PAYMENT_PROOF_ALLOWED_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

// Human-readable format list for form copy, so the UI never drifts from the table above.
export const PAYMENT_PROOF_FORMAT_HINT = PAYMENT_PROOF_ALLOWED_EXTENSIONS.map((extension) =>
  extension.toUpperCase(),
).join(", ");

/** Lowercased extension without the dot, or "" when the name has none. */
export const getPaymentProofFileExtension = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
};

const formatForFileName = (fileName: string): PaymentProofFormat | null =>
  FORMAT_BY_EXTENSION[getPaymentProofFileExtension(fileName)] ?? null;

/**
 * The content type to declare at presign and store on the proof row.
 *
 * Derived from the FILENAME, never from the browser's own `file.type`, which is empty for several
 * formats and client-controlled in every case, and the presigned URL binds whatever is declared
 * here, so a client-chosen value would be a client-chosen signature.
 */
export const paymentProofMimeTypeForFileName = (fileName: string): string | null =>
  formatForFileName(fileName)?.mimeType ?? null;

const formatMegabytes = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
};

/**
 * Client-side pre-validation of a chosen receipt.
 *
 * Returns a localized message when the file is not acceptable, or null when it passes. Advisory
 * only: the server re-derives the type from the filename at presign and the organiser sees the
 * bytes. This exists to spare a candidate a failed upload, not to decide anything.
 */
export const preValidatePaymentProofFile = (file: {
  name: string;
  size: number;
}): string | null => {
  if (formatForFileName(file.name) === null) {
    return `Format tidak didukung. Unggah bukti transfer dalam format ${PAYMENT_PROOF_FORMAT_HINT}.`;
  }
  if (file.size > PAYMENT_PROOF_MAX_BYTES) {
    return `Ukuran berkas melebihi ${formatMegabytes(PAYMENT_PROOF_MAX_BYTES)}.`;
  }
  if (file.size === 0) {
    return "Berkas kosong. Pilih berkas lain.";
  }
  return null;
};
