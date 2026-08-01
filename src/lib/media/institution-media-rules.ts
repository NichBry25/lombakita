// Upload rules for institution imagery. Client-safe (no server imports) so the browser upload
// helper can pre-validate a file before requesting an upload URL.
//
// Both kinds are cropped to a fixed frame before upload (see image-frames.ts), so the byte limits
// govern the source file the browser reads, not what is ultimately stored.

import { IMAGE_UPLOAD_MIME_TYPES } from "@/lib/media/image-frames";

export type InstitutionMediaKind = "logo" | "banner";

export const INSTITUTION_MEDIA_RULES: Record<
  InstitutionMediaKind,
  { prefix: string; maxBytes: number; mimeTypes: readonly string[] }
> = {
  logo: {
    prefix: "institution-logos",
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: IMAGE_UPLOAD_MIME_TYPES,
  },
  banner: {
    prefix: "institution-banners",
    maxBytes: 8 * 1024 * 1024,
    mimeTypes: IMAGE_UPLOAD_MIME_TYPES,
  },
};
