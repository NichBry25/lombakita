import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/user-profile/profile-files-service");

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { profileCertifications, userProfiles } from "@/server/db/schema";
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  isR2Available,
} from "@/server/storage/r2.client";
import {
  PROFILE_FILE_READ_EXPIRY_SECONDS,
  PROFILE_FILE_RULES,
  PROFILE_FILE_UPLOAD_EXPIRY_SECONDS,
  ProfileFileError,
  type ProfileFileMetadata,
  type ProfileFileUploadRequest,
} from "@/server/user-profile/profile-files-core";
import { logger } from "@/lib/logger";

export type UploadUrlGrant = { uploadUrl: string; fileKey: string; expiresAt: Date };

// Presign a read URL for a stored key. Returns null when there is no key or R2 is unavailable, so
// callers degrade gracefully (a missing avatar/resume/cert-file link, never a 500).
export const resolveProfileFileUrl = async (key: string | null): Promise<string | null> => {
  if (!key || !isR2Available()) {
    return null;
  }
  try {
    return await generatePresignedGetUrl(key, PROFILE_FILE_READ_EXPIRY_SECONDS);
  } catch (error) {
    logger.warn("profile.file.read-url.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const assertR2Available = (): void => {
  if (!isR2Available()) {
    throw new ProfileFileError(
      "profile_file_unavailable",
      "File storage is not configured — uploads are temporarily unavailable",
    );
  }
};

const mintUploadUrl = async (
  fileKey: string,
  request: ProfileFileUploadRequest,
  now: Date,
): Promise<UploadUrlGrant> => {
  const uploadUrl = await generatePresignedPutUrl(
    fileKey,
    request.mimeType,
    PROFILE_FILE_UPLOAD_EXPIRY_SECONDS,
  );
  const expiresAt = new Date(now.getTime() + PROFILE_FILE_UPLOAD_EXPIRY_SECONDS * 1000);
  return { uploadUrl, fileKey, expiresAt };
};

const assertKeyPrefix = (key: string, prefix: string): void => {
  if (!key.startsWith(prefix)) {
    throw new ProfileFileError(
      "profile_file_invalid_key",
      "fileKey is not scoped to this upload target",
    );
  }
};

// Ensures a user_profiles row exists before setting a file column (a fresh account may not have
// one yet), then applies the column updates.
const upsertProfileColumns = async (
  userId: string,
  columns: Partial<typeof userProfiles.$inferInsert>,
  db: Database,
): Promise<void> => {
  await db
    .insert(userProfiles)
    .values({ userId, ...columns })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { ...columns, updatedAt: new Date() },
    });
};

// ── Avatar ────────────────────────────────────────────────────────────────

export const generateAvatarUploadUrl = async (
  userId: string,
  request: ProfileFileUploadRequest,
  now: Date = new Date(),
): Promise<UploadUrlGrant> => {
  assertR2Available();
  const fileKey = `${PROFILE_FILE_RULES.avatar.prefix}/${userId}/${randomUUID()}`;
  return mintUploadUrl(fileKey, request, now);
};

export const recordAvatar = async (
  userId: string,
  metadata: ProfileFileMetadata,
  db: Database = getDb(),
): Promise<void> => {
  assertKeyPrefix(metadata.fileKey, `${PROFILE_FILE_RULES.avatar.prefix}/${userId}/`);
  await upsertProfileColumns(userId, { avatarR2Key: metadata.fileKey }, db);
};

export const deleteAvatar = async (userId: string, db: Database = getDb()): Promise<void> => {
  await db
    .update(userProfiles)
    .set({ avatarR2Key: null, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));
};

// ── Resume ──────────────────────────────────────────────────────────────────

export const generateResumeUploadUrl = async (
  userId: string,
  request: ProfileFileUploadRequest,
  now: Date = new Date(),
): Promise<UploadUrlGrant> => {
  assertR2Available();
  const fileKey = `${PROFILE_FILE_RULES.resume.prefix}/${userId}/${randomUUID()}`;
  return mintUploadUrl(fileKey, request, now);
};

export const recordResume = async (
  userId: string,
  metadata: ProfileFileMetadata,
  db: Database = getDb(),
): Promise<void> => {
  assertKeyPrefix(metadata.fileKey, `${PROFILE_FILE_RULES.resume.prefix}/${userId}/`);
  await upsertProfileColumns(
    userId,
    {
      resumeR2Key: metadata.fileKey,
      resumeFileName: metadata.fileName,
      resumeSizeBytes: metadata.sizeBytes,
      resumeMimeType: metadata.mimeType,
      resumeUploadedAt: new Date(),
    },
    db,
  );
};

export const deleteResume = async (userId: string, db: Database = getDb()): Promise<void> => {
  await db
    .update(userProfiles)
    .set({
      resumeR2Key: null,
      resumeFileName: null,
      resumeSizeBytes: null,
      resumeMimeType: null,
      resumeUploadedAt: null,
      resumePublic: false,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.userId, userId));
};

export const setResumeVisibility = async (
  userId: string,
  isPublic: boolean,
  db: Database = getDb(),
): Promise<void> => {
  await db
    .update(userProfiles)
    .set({ resumePublic: isPublic, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));
};

// ── Certificate file ──────────────────────────────────────────────────────────

// Confirms the certification row belongs to the caller before minting an upload URL.
const requireOwnedCertification = async (
  userId: string,
  certId: string,
  db: Database,
): Promise<void> => {
  const [row] = await db
    .select({ id: profileCertifications.id })
    .from(profileCertifications)
    .where(and(eq(profileCertifications.id, certId), eq(profileCertifications.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ProfileFileError("profile_file_not_found", "Certification not found");
  }
};

export const generateCertificationFileUploadUrl = async (
  userId: string,
  certId: string,
  request: ProfileFileUploadRequest,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<UploadUrlGrant> => {
  assertR2Available();
  await requireOwnedCertification(userId, certId, db);
  const fileKey = `${PROFILE_FILE_RULES.certification.prefix}/${userId}/${certId}/${randomUUID()}`;
  return mintUploadUrl(fileKey, request, now);
};

export const recordCertificationFile = async (
  userId: string,
  certId: string,
  metadata: ProfileFileMetadata,
  db: Database = getDb(),
): Promise<void> => {
  assertKeyPrefix(
    metadata.fileKey,
    `${PROFILE_FILE_RULES.certification.prefix}/${userId}/${certId}/`,
  );
  const [row] = await db
    .update(profileCertifications)
    .set({
      fileR2Key: metadata.fileKey,
      fileName: metadata.fileName,
      fileSizeBytes: metadata.sizeBytes,
      fileMimeType: metadata.mimeType,
      updatedAt: sql`now()`,
    })
    .where(and(eq(profileCertifications.id, certId), eq(profileCertifications.userId, userId)))
    .returning({ id: profileCertifications.id });
  if (!row) {
    throw new ProfileFileError("profile_file_not_found", "Certification not found");
  }
};

export const deleteCertificationFile = async (
  userId: string,
  certId: string,
  db: Database = getDb(),
): Promise<void> => {
  const [row] = await db
    .update(profileCertifications)
    .set({
      fileR2Key: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(profileCertifications.id, certId), eq(profileCertifications.userId, userId)))
    .returning({ id: profileCertifications.id });
  if (!row) {
    throw new ProfileFileError("profile_file_not_found", "Certification not found");
  }
};
