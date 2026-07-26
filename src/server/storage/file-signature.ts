// Magic-byte file-type detection. Reads the leading bytes of an uploaded object and returns the
// canonical MIME type implied by its binary signature, or null when no known signature matches.
// This is the content-validation half of the upload-security model: a client can lie about a
// file's declared Content-Type and extension, but not about the bytes stored in R2. Only the
// signatures for the formats the platform accepts are implemented — an unrecognised file returns
// null and is rejected by the caller.

export type DetectedFileType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
};

// "%PDF-"
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
// JPEG SOI + first marker byte (JFIF/EXIF/raw all share FF D8 FF)
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
// PNG 8-byte signature
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// WebP is a RIFF container: bytes 0-3 "RIFF", bytes 8-11 "WEBP"
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50] as const;

const isWebp = (bytes: Uint8Array): boolean => {
  if (!startsWith(bytes, RIFF_SIGNATURE)) return false;
  if (bytes.length < 12) return false;
  return WEBP_TAG.every((byte, index) => bytes[index + 8] === byte);
};

// Returns the MIME type the leading bytes actually are, independent of any declared value. Callers
// pass the first few KB of the object (the header region is enough for every supported signature).
export const detectFileType = (bytes: Uint8Array): DetectedFileType | null => {
  if (startsWith(bytes, PDF_SIGNATURE)) return "application/pdf";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (isWebp(bytes)) return "image/webp";
  return null;
};
