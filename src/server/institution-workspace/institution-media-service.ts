import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-workspace/institution-media-service");

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutions } from "@/server/db/schema";
import {
  INSTITUTION_MEDIA_RULES,
  type InstitutionMediaKind,
} from "@/lib/media/institution-media-rules";
import { InstitutionProfileInputError } from "@/server/institution-workspace/institution-profile-core";
import {
  buildInstitutionWorkspaceAccessDeniedError,
  findInstitutionWorkspaceByOwnerAndSlug,
} from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { parseInstitutionSlugParam } from "@/server/institution-workspace/institution-core";
import { generatePresignedPutUrl, isR2Available } from "@/server/storage/r2.client";

const UPLOAD_URL_EXPIRY_SECONDS = 300;

// The column each media kind is stored in. Keeping this a lookup rather than a branch means adding
// a third kind cannot leave one of the three operations behind.
const MEDIA_COLUMN: Record<InstitutionMediaKind, "logoR2Key" | "bannerR2Key"> = {
  logo: "logoR2Key",
  banner: "bannerR2Key",
};

// Drizzle's `.set()` is keyed by the TypeScript property name, so the column is applied to a typed
// partial rather than spread in as a computed key (which would widen to a plain string).
const mediaKeyUpdate = (
  kind: InstitutionMediaKind,
  fileKey: string | null,
): Partial<typeof institutions.$inferInsert> => {
  const patch: Partial<typeof institutions.$inferInsert> = { updatedAt: new Date() };
  patch[MEDIA_COLUMN[kind]] = fileKey;
  return patch;
};

export type InstitutionMediaUploadGrant = { uploadUrl: string; fileKey: string; expiresAt: Date };

// Resolves the slug to an institution the caller owns and which is allowed to hold its own imagery.
// A personal institution renders its owner's profile photo and banner instead, so it has nothing to
// upload to — the refusal is what keeps the derived state the only state.
const requireUploadableInstitution = async (
  userId: string,
  institutionSlug: string,
  db: Database,
): Promise<{ institutionId: string }> => {
  const normalizedSlug = parseInstitutionSlugParam(institutionSlug);
  const current = await findInstitutionWorkspaceByOwnerAndSlug(userId, normalizedSlug, db);
  if (!current) {
    throw await buildInstitutionWorkspaceAccessDeniedError(userId, normalizedSlug, db);
  }

  if (isPersonalInstitutionType(current.institutionType ?? null)) {
    throw new InstitutionProfileInputError(
      "institution_profile_not_editable",
      "A personal institution shows its owner's profile photo and banner, which are edited on the owner's profile",
      undefined,
      403,
    );
  }

  return { institutionId: current.institutionId };
};

const assertR2Available = (): void => {
  if (!isR2Available()) {
    throw new InstitutionProfileInputError(
      "institution_profile_storage_unavailable",
      "Image storage is unavailable",
      undefined,
      503,
    );
  }
};

// Presigns a direct-to-R2 PUT. Deliberately writes NOTHING to the database: the key is recorded
// only once the browser reports the object has landed (see recordInstitutionMedia). Storing it here
// would point the column at an object that may never exist if the upload is abandoned, while having
// already discarded the image it replaced.
export const generateInstitutionMediaUploadUrl = async (
  userId: string,
  institutionSlug: string,
  kind: InstitutionMediaKind,
  file: { contentType: string },
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<InstitutionMediaUploadGrant> => {
  const { institutionId } = await requireUploadableInstitution(userId, institutionSlug, db);
  assertR2Available();

  const fileKey = `${INSTITUTION_MEDIA_RULES[kind].prefix}/${institutionId}/${randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(
    fileKey,
    file.contentType,
    UPLOAD_URL_EXPIRY_SECONDS,
  );

  return {
    uploadUrl,
    fileKey,
    expiresAt: new Date(now.getTime() + UPLOAD_URL_EXPIRY_SECONDS * 1000),
  };
};

// Records a key the browser has finished uploading. The prefix check is the ownership boundary: a
// caller cannot point their institution at an object belonging to another one.
export const recordInstitutionMedia = async (
  userId: string,
  institutionSlug: string,
  kind: InstitutionMediaKind,
  fileKey: string,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireUploadableInstitution(userId, institutionSlug, db);

  const expectedPrefix = `${INSTITUTION_MEDIA_RULES[kind].prefix}/${institutionId}/`;
  if (!fileKey.startsWith(expectedPrefix)) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_value",
      "fileKey is not scoped to this institution",
      { fields: ["fileKey"] },
    );
  }

  await db
    .update(institutions)
    .set(mediaKeyUpdate(kind, fileKey))
    .where(eq(institutions.id, institutionId));
};

export const deleteInstitutionMedia = async (
  userId: string,
  institutionSlug: string,
  kind: InstitutionMediaKind,
  db: Database = getDb(),
): Promise<void> => {
  const { institutionId } = await requireUploadableInstitution(userId, institutionSlug, db);

  await db
    .update(institutions)
    .set(mediaKeyUpdate(kind, null))
    .where(eq(institutions.id, institutionId));
};
