import { eq, sql } from "drizzle-orm";
import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import { userProfiles, users } from "@/server/db/schema";
import {
  parseStudentProfileUpdatePatch,
  type StudentProfileShell,
  type StudentProfileUpdatePatch,
} from "@/server/student-profile/profile-core";

type StudentProfileRow = {
  userId: string;
  email: string;
  accountName: string | null;
  profileDisplayName: string | null;
  profilePhoneNumber: string | null;
  profileSummary: string | null;
  profileCreatedAt: Date | null;
  profileUpdatedAt: Date | null;
};

const mapStudentProfile = (row: StudentProfileRow): StudentProfileShell => {
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.profileDisplayName ?? row.accountName,
    phoneNumber: row.profilePhoneNumber,
    headline: row.profileSummary,
    createdAt: row.profileCreatedAt,
    updatedAt: row.profileUpdatedAt ?? row.profileCreatedAt,
  };
};

const findStudentProfileRow = async (
  userId: string,
  db: Database,
): Promise<StudentProfileRow | null> => {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      accountName: users.name,
      profileDisplayName: userProfiles.displayName,
      profilePhoneNumber: userProfiles.phoneNumber,
      profileSummary: userProfiles.summary,
      profileCreatedAt: userProfiles.createdAt,
      profileUpdatedAt: userProfiles.updatedAt,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
};

const updateStudentProfileRecord = async (
  userId: string,
  patch: StudentProfileUpdatePatch,
  db: Database,
): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx
      .insert(userProfiles)
      .values({
        userId,
        displayName: patch.displayName ?? null,
        phoneNumber: patch.phoneNumber ?? null,
        summary: patch.headline ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.phoneNumber !== undefined ? { phoneNumber: patch.phoneNumber } : {}),
          ...(patch.headline !== undefined ? { summary: patch.headline } : {}),
          updatedAt: sql`now()`,
        },
      });

    if (patch.displayName !== undefined) {
      await tx
        .update(users)
        .set({
          name: patch.displayName,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));
    }
  });
};

export const getStudentProfileForUser = async (
  userId: string,
  db: Database = getDb(),
): Promise<StudentProfileShell> => {
  const row = await findStudentProfileRow(userId, db);

  if (!row) {
    throw new AccessError("forbidden", 403, "User-domain record not found");
  }

  return mapStudentProfile(row);
};

export const updateStudentProfileForUser = async (
  userId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<StudentProfileShell> => {
  const patch = parseStudentProfileUpdatePatch(payload);

  await updateStudentProfileRecord(userId, patch, db);

  return getStudentProfileForUser(userId, db);
};
