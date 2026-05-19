import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { userProfiles, users } from "@/server/db/schema";
import {
  buildOwnerProfileResponse,
  buildPublicProfileResponse,
  ProfileInputError,
  type OwnerProfileResponse,
  type ProfilePatch,
  type PublicProfileResponse,
} from "@/server/user-profile/profile-core";

type UserProfileRow = {
  id: string;
  username: string;
  email: string;
  role: string;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  displayName: string | null;
  summary: string | null;
  location: string | null;
  avatarUrl: string | null;
  university: string | null;
  major: string | null;
  graduationYear: number | null;
  roleTitle: string | null;
  organizationName: string | null;
  websiteUrl: string | null;
};

const PROFILE_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  role: users.role,
  candidateVerifiedAt: users.candidateVerifiedAt,
  recruiterVerifiedAt: users.recruiterVerifiedAt,
  displayName: userProfiles.displayName,
  summary: userProfiles.summary,
  location: userProfiles.location,
  avatarUrl: userProfiles.avatarUrl,
  university: userProfiles.university,
  major: userProfiles.major,
  graduationYear: userProfiles.graduationYear,
  roleTitle: userProfiles.roleTitle,
  organizationName: userProfiles.organizationName,
  websiteUrl: userProfiles.websiteUrl,
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

export const getOwnerProfile = async (
  userId: string,
  db: Database = getDb(),
): Promise<OwnerProfileResponse> => {
  const row = await findUserProfileByUserId(userId, db);

  if (!row) {
    throw new ProfileInputError("profile_invalid_payload", "Profile not found");
  }

  return buildOwnerProfileResponse(row);
};

export const getPublicProfile = async (
  username: string,
  db: Database = getDb(),
): Promise<PublicProfileResponse | null> => {
  const row = await findUserProfileByUsername(username, db);

  if (!row) return null;

  return buildPublicProfileResponse(row);
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

// Fetches the account's verification state. Route layer calls this before parseProfilePatch
// so scope-gating is enforced with current DB values (not session token values).
export const getVerificationState = async (
  userId: string,
  db: Database = getDb(),
): Promise<{ candidateVerified: boolean; recruiterVerified: boolean } | null> => {
  const [row] = await db
    .select({
      candidateVerifiedAt: users.candidateVerifiedAt,
      recruiterVerifiedAt: users.recruiterVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return null;

  return {
    candidateVerified: row.candidateVerifiedAt !== null,
    recruiterVerified: row.recruiterVerifiedAt !== null,
  };
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

  await db.transaction(async (tx) => {
    // --- users table update ---
    type UsersSet = Parameters<typeof tx.update>[0] extends typeof users
      ? Parameters<ReturnType<typeof tx.update>["set"]>[0]
      : never;
    const usersSet: { updatedAt: ReturnType<typeof sql>; username?: string; name?: string | null } = {
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
    const profileFieldsInPatch = (
      ["displayName", "bio", "location", "avatarUrl", "university", "major", "graduationYear", "roleTitle", "organizationName", "websiteUrl"] as const
    ).filter((f) => f in patch);

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
      } else if (field === "avatarUrl") {
        insertValues.avatarUrl = value as string | null | undefined;
        updateSet.avatarUrl = value as string | null | undefined;
      } else if (field === "university") {
        insertValues.university = value as string | null | undefined;
        updateSet.university = value as string | null | undefined;
      } else if (field === "major") {
        insertValues.major = value as string | null | undefined;
        updateSet.major = value as string | null | undefined;
      } else if (field === "graduationYear") {
        insertValues.graduationYear = value as number | null | undefined;
        updateSet.graduationYear = value as number | null | undefined;
      } else if (field === "roleTitle") {
        insertValues.roleTitle = value as string | null | undefined;
        updateSet.roleTitle = value as string | null | undefined;
      } else if (field === "organizationName") {
        insertValues.organizationName = value as string | null | undefined;
        updateSet.organizationName = value as string | null | undefined;
      } else if (field === "websiteUrl") {
        insertValues.websiteUrl = value as string | null | undefined;
        updateSet.websiteUrl = value as string | null | undefined;
      }
    }

    await tx
      .insert(userProfiles)
      .values(insertValues)
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: updateSet,
      });
  });

  return getOwnerProfile(userId, db);
};
