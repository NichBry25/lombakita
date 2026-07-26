import { eq, sql } from "drizzle-orm";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { getDb, type Database } from "@/server/db/client";
import { userProfiles, users } from "@/server/db/schema";
import {
  findOwnedPersonalInstitution,
  rewritePersonalInstitutionSlugForUsername,
  usernameCollidesWithInstitutionSlug,
} from "@/server/institution-workspace/institution-service";
import { logger } from "@/lib/logger";
import {
  buildOwnerProfileResponse,
  buildPublicProfileResponse,
  ProfileInputError,
  type OwnerProfileResponse,
  type ProfilePatch,
  type PublicProfileResponse,
} from "@/server/user-profile/profile-core";
import { getProfileCollections } from "@/server/user-profile/profile-collections-service";
import { resolveProfileFileUrl } from "@/server/user-profile/profile-files-service";
import type { OwnerResume, PublicResume } from "@/server/user-profile/profile-collections-core";

type UserProfileRow = {
  id: string;
  username: string;
  email: string;
  role: string;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  recruiterVerificationTier: "unverified" | "minimal" | "elevated";
  displayName: string | null;
  summary: string | null;
  location: string | null;
  avatarUrl: string | null;
  avatarR2Key: string | null;
  resumeR2Key: string | null;
  resumeFileName: string | null;
  resumeSizeBytes: number | null;
  resumeMimeType: string | null;
  resumePublic: boolean | null;
};

const PROFILE_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  role: users.role,
  candidateVerifiedAt: users.candidateVerifiedAt,
  recruiterVerifiedAt: users.recruiterVerifiedAt,
  recruiterVerificationTier: users.recruiterVerificationTier,
  displayName: userProfiles.displayName,
  summary: userProfiles.summary,
  location: userProfiles.location,
  avatarUrl: userProfiles.avatarUrl,
  avatarR2Key: userProfiles.avatarR2Key,
  resumeR2Key: userProfiles.resumeR2Key,
  resumeFileName: userProfiles.resumeFileName,
  resumeSizeBytes: userProfiles.resumeSizeBytes,
  resumeMimeType: userProfiles.resumeMimeType,
  resumePublic: userProfiles.resumePublic,
} as const;

const findUserProfileByUserId = async (
  userId: string,
  db: Database,
): Promise<UserProfileRow | null> => {
  const [row] = await db
    .select(PROFILE_COLUMNS)
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
};

const findUserProfileByUsername = async (
  username: string,
  db: Database,
): Promise<UserProfileRow | null> => {
  const [row] = await db
    .select(PROFILE_COLUMNS)
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.username, username))
    .limit(1);

  return row ?? null;
};

// Resolves the display avatar URL: a presigned GET on the uploaded R2 key when present, else the
// legacy external URL fallback, else null.
const resolveAvatarUrl = async (row: UserProfileRow): Promise<string | null> => {
  const uploaded = await resolveProfileFileUrl(row.avatarR2Key);
  return uploaded ?? row.avatarUrl;
};

const buildOwnerResume = async (row: UserProfileRow): Promise<OwnerResume | null> => {
  if (!row.resumeR2Key) return null;
  return {
    fileName: row.resumeFileName ?? "resume",
    sizeBytes: row.resumeSizeBytes,
    mimeType: row.resumeMimeType,
    isPublic: row.resumePublic === true,
    downloadUrl: await resolveProfileFileUrl(row.resumeR2Key),
  };
};

const buildPublicResume = async (row: UserProfileRow): Promise<PublicResume | null> => {
  if (!row.resumeR2Key || row.resumePublic !== true) return null;
  return {
    fileName: row.resumeFileName ?? "resume",
    downloadUrl: await resolveProfileFileUrl(row.resumeR2Key),
  };
};

export const getOwnerProfile = async (
  userId: string,
  db: Database = getDb(),
): Promise<OwnerProfileResponse> => {
  const row = await findUserProfileByUserId(userId, db);

  if (!row) {
    throw new ProfileInputError("profile_invalid_payload", "Profile not found");
  }

  const collections = await getProfileCollections(row.id, db);
  const response = buildOwnerProfileResponse(row, collections);
  const avatarUrl = await resolveAvatarUrl(row);
  response.avatarUrl = avatarUrl
    ? { status: "populated", value: avatarUrl }
    : { status: "empty", value: null };
  response.resume = await buildOwnerResume(row);
  return response;
};

export const getPublicProfile = async (
  username: string,
  db: Database = getDb(),
): Promise<PublicProfileResponse | null> => {
  const row = await findUserProfileByUsername(username, db);

  if (!row) return null;

  const collections = await getProfileCollections(row.id, db);
  const response = buildPublicProfileResponse(row, collections);
  response.avatarUrl = await resolveAvatarUrl(row);
  response.resume = await buildPublicResume(row);
  return response;
};

export const isUsernameOwnedBy = async (
  username: string,
  userId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  return row?.id === userId;
};

export const isUsernameTaken = async (
  username: string,
  excludeUserId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  return Boolean(row && row.id !== excludeUserId);
};

export const updateOwnerProfile = async (
  userId: string,
  patch: ProfilePatch,
  db: Database = getDb(),
): Promise<OwnerProfileResponse> => {
  if (patch.username !== undefined) {
    const taken = await isUsernameTaken(patch.username, userId, db);
    if (taken) {
      throw new ProfileInputError("profile_username_taken", "This username is already taken", {
        fields: ["username"],
      });
    }
  }

  // A personal institution's slug follows its owner's username, so a username change must rewrite
  // that slug and re-index the institution's published competitions. The published-competition ids
  // are collected inside the transaction and re-synced after commit (fire-and-forget, never blocks).
  let competitionIdsToResync: string[] = [];

  await db.transaction(async (tx) => {
    // --- username-change guards + personal-institution slug rewrite ---
    // Both run inside the transaction so a rejection or rewrite failure rolls the username change
    // back atomically. Fix B (collision rejection) runs before Fix A (slug rewrite).
    if (patch.username !== undefined) {
      const personalInstitution = await findOwnedPersonalInstitution(userId, tx);

      // Fix B: a username that normalizes to a slug already held by another institution is rejected.
      // The actor's own personal institution is excluded — Fix A rewrites it to match the new name.
      const collides = await usernameCollidesWithInstitutionSlug(
        patch.username,
        personalInstitution?.institutionId ?? null,
        tx,
      );
      if (collides) {
        throw new ProfileInputError(
          "profile_username_conflicts_with_institution",
          "This username conflicts with an existing institution and cannot be used",
          { fields: ["username"] },
        );
      }

      // Fix A: rewrite the personal institution's slug to follow the new username.
      if (personalInstitution) {
        competitionIdsToResync = await rewritePersonalInstitutionSlugForUsername(
          personalInstitution.institutionId,
          patch.username,
          tx,
        );
      }
    }

    // --- users table update ---
    type UsersSet = Parameters<typeof tx.update>[0] extends typeof users
      ? Parameters<ReturnType<typeof tx.update>["set"]>[0]
      : never;
    const usersSet: { updatedAt: ReturnType<typeof sql>; username?: string; name?: string | null } =
      {
        updatedAt: sql`now()`,
      };
    if (patch.username !== undefined) usersSet.username = patch.username;
    if (patch.displayName !== undefined) usersSet.name = patch.displayName;

    if (patch.username !== undefined || patch.displayName !== undefined) {
      await tx
        .update(users)
        .set(usersSet as UsersSet)
        .where(eq(users.id, userId));
    }

    // --- user_profiles upsert ---
    // Only upsert if any profile field is being changed.
    const profileFieldsInPatch = (["displayName", "bio", "location"] as const).filter(
      (f) => f in patch,
    );

    if (profileFieldsInPatch.length === 0) return;

    // `bio` in the API maps to `summary` in the DB column (debt: column rename deferred to next
    // schema-touching step). All other profile fields map 1:1 to column names.
    const insertValues: typeof userProfiles.$inferInsert = { userId };
    const updateSet: Partial<typeof userProfiles.$inferInsert> = { updatedAt: new Date() };

    for (const field of profileFieldsInPatch) {
      const value = patch[field];
      if (field === "bio") {
        insertValues.summary = value as string | null | undefined;
        updateSet.summary = value as string | null | undefined;
      } else if (field === "displayName") {
        insertValues.displayName = value as string | null | undefined;
        updateSet.displayName = value as string | null | undefined;
      } else if (field === "location") {
        insertValues.location = value as string | null | undefined;
        updateSet.location = value as string | null | undefined;
      }
    }

    await tx.insert(userProfiles).values(insertValues).onConflictDoUpdate({
      target: userProfiles.userId,
      set: updateSet,
    });
  });

  // Re-sync the renamed institution's published competitions so the cached institutionSlug in the
  // search index follows the new slug. Fire-and-forget after commit: a failure here must not fail
  // the profile update (the DB slug is already correct; the index self-heals on the next sync).
  for (const competitionId of competitionIdsToResync) {
    enqueueCompetitionSearchSync({ competitionId, action: "upsert" }).catch((err) => {
      logger.warn("profile.username-change.search-sync.enqueue-failed", {
        competitionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return getOwnerProfile(userId, db);
};
