// Magic-byte file-type detection. Reads the leading bytes of an uploaded object and returns the
// canonical MIME type implied by its binary signature, or null when no known signature matches.
// This is the content-validation half of the upload-security model: a client can lie about a
// file's declared Content-Type and extension, but not about the bytes stored in R2. Only the
// signatures for the formats the platform accepts are implemented — an unrecognised file returns
// null and is rejected by the caller.

// The formats identity documents may be. Deliberately narrow — every one of these is safe to
// render inline in a browser tab.
export type DetectedFileType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

// Every signature family this module can confirm. Competition submissions accept the wider set
// (archives, Office documents, video); identity documents do not — see `detectFileType`.
export type DetectedFileFamily = DetectedFileType | "application/zip" | "image/gif" | "video/mp4";

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

// GIF header: "GIF87a" or "GIF89a"
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;
const GIF_VERSION_BYTES = [0x37, 0x39] as const;
// ZIP local file header ("PK\x03\x04") and the empty-archive end-of-central-directory record
// ("PK\x05\x06"). Every OOXML Office file is a zip, so all of them land here.
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
const EMPTY_ZIP_SIGNATURE = [0x50, 0x4b, 0x05, 0x06] as const;
// ISO base media (MP4): bytes 4-7 are "ftyp"; bytes 0-3 are the box size, which varies.
const FTYP_TAG = [0x66, 0x74, 0x79, 0x70] as const;

const isGif = (bytes: Uint8Array): boolean => {
  if (!startsWith(bytes, GIF_SIGNATURE)) return false;
  if (bytes.length < 6) return false;
  const version = bytes[4];
  return (
    version !== undefined &&
    (GIF_VERSION_BYTES as readonly number[]).includes(version) &&
    bytes[5] === 0x61
  );
};

const isMp4 = (bytes: Uint8Array): boolean => {
  if (bytes.length < 8) return false;
  return FTYP_TAG.every((byte, index) => bytes[index + 4] === byte);
};

// Returns the signature family the leading bytes actually are, independent of any declared value.
// Callers pass the first few KB of the object (the header region is enough for every supported
// signature). A family is coarser than a format: an OOXML .docx and a plain .zip are both
// "application/zip", because that is genuinely all the bytes prove.
export const detectFileFamily = (bytes: Uint8Array): DetectedFileFamily | null => {
  if (startsWith(bytes, PDF_SIGNATURE)) return "application/pdf";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (isWebp(bytes)) return "image/webp";
  if (isGif(bytes)) return "image/gif";
  if (startsWith(bytes, ZIP_SIGNATURE) || startsWith(bytes, EMPTY_ZIP_SIGNATURE)) {
    return "application/zip";
  }
  if (isMp4(bytes)) return "video/mp4";
  return null;
};

const DOCUMENT_FILE_TYPES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// The identity-document detector: `detectFileFamily` narrowed to the four formats that flow
// accepts. Anything outside them — including a family this module can now recognise — returns
// null, exactly as it did before the wider families existed.
export const detectFileType = (bytes: Uint8Array): DetectedFileType | null => {
  const family = detectFileFamily(bytes);
  if (family === null || !DOCUMENT_FILE_TYPES.has(family)) return null;
  return family as DetectedFileType;
};
