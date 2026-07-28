import { logger } from "@/lib/logger";
import {
  resolveInstitutionMediaKeys,
  type InstitutionMediaSource,
  type InstitutionOwnerMedia,
} from "@/server/institution-workspace/institution-media";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";

// Turning stored object keys into displayable URLs. Kept apart from the key derivation itself so
// that derivation stays a pure function with no storage dependency, and apart from
// institution-media-service so read paths can use it without importing the write path (which
// depends on institution-service and would form a cycle).

const READ_URL_EXPIRY_SECONDS = 3600;

// Returns null when there is no key or R2 is unavailable, so callers degrade to a placeholder
// rather than a 500 — matching resolveProfileFileUrl.
export const resolveInstitutionMediaUrl = async (key: string | null): Promise<string | null> => {
  if (!key || !isR2Available()) {
    return null;
  }
  try {
    return await generatePresignedGetUrl(key, READ_URL_EXPIRY_SECONDS);
  } catch (error) {
    logger.warn("institution.media.read-url.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

// Resolves both display URLs for an institution in one step, applying the personal derivation.
export const resolveInstitutionMediaUrls = async (
  institution: InstitutionMediaSource,
  ownerMedia?: InstitutionOwnerMedia | null,
): Promise<{ logoUrl: string | null; bannerUrl: string | null }> => {
  const { logoKey, bannerKey } = resolveInstitutionMediaKeys(institution, ownerMedia);
  const [logoUrl, bannerUrl] = await Promise.all([
    resolveInstitutionMediaUrl(logoKey),
    resolveInstitutionMediaUrl(bannerKey),
  ]);
  return { logoUrl, bannerUrl };
};
