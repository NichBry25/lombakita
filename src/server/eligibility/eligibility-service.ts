import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/eligibility/eligibility-service");

import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { studentEligibilityProfiles } from "@/server/db/schema";
import {
  evaluateEligibility,
  parseEligibilityProfileUpdatePatch,
  type EligibilityProfileSnapshot,
  type EligibilityProfileUpdatePatch,
  type EligibilityResult,
} from "@/server/eligibility/eligibility-core";

export type StudentEligibilityProfileShell = EligibilityProfileSnapshot & {
  userId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
};

const EMPTY_SNAPSHOT: EligibilityProfileSnapshot = {
  dateOfBirth: null,
  enrollmentStatus: null,
  educationLevel: null,
  universityName: null,
  studentIdNumber: null,
};

const findEligibilityRow = async (
  userId: string,
  db: Database,
): Promise<StudentEligibilityProfileShell | null> => {
  const [row] = await db
    .select({
      userId: studentEligibilityProfiles.userId,
      dateOfBirth: studentEligibilityProfiles.dateOfBirth,
      enrollmentStatus: studentEligibilityProfiles.enrollmentStatus,
      educationLevel: studentEligibilityProfiles.educationLevel,
      universityName: studentEligibilityProfiles.universityName,
      studentIdNumber: studentEligibilityProfiles.studentIdNumber,
      createdAt: studentEligibilityProfiles.createdAt,
      updatedAt: studentEligibilityProfiles.updatedAt,
    })
    .from(studentEligibilityProfiles)
    .where(eq(studentEligibilityProfiles.userId, userId))
    .limit(1);

  return row ?? null;
};

// Returns the student's stored eligibility input fields (or empty shell when no row exists).
// Never returns another student's data; caller must scope userId to the authenticated session.
export const getStudentEligibilityProfile = async (
  userId: string,
  db: Database = getDb(),
): Promise<StudentEligibilityProfileShell> => {
  const row = await findEligibilityRow(userId, db);

  if (!row) {
    return {
      userId,
      ...EMPTY_SNAPSHOT,
      createdAt: null,
      updatedAt: null,
    };
  }

  return row;
};

// Pure-read eligibility check. No side effects, no caching — every call hits the DB and
// recomputes status from current field values plus current server time.
export const checkStudentEligibility = async (
  userId: string,
  db: Database = getDb(),
): Promise<EligibilityResult> => {
  const profile = await getStudentEligibilityProfile(userId, db);

  const snapshot: EligibilityProfileSnapshot = {
    dateOfBirth: profile.dateOfBirth,
    enrollmentStatus: profile.enrollmentStatus,
    educationLevel: profile.educationLevel,
    universityName: profile.universityName,
    studentIdNumber: profile.studentIdNumber,
  };

  return evaluateEligibility(snapshot, new Date());
};

const upsertEligibilityProfile = async (
  userId: string,
  patch: EligibilityProfileUpdatePatch,
  db: Database,
): Promise<void> => {
  await db
    .insert(studentEligibilityProfiles)
    .values({
      userId,
      dateOfBirth: patch.dateOfBirth ?? null,
      enrollmentStatus: patch.enrollmentStatus ?? null,
      educationLevel: patch.educationLevel ?? null,
      universityName: patch.universityName ?? null,
      studentIdNumber: patch.studentIdNumber ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: studentEligibilityProfiles.userId,
      set: {
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth } : {}),
        ...(patch.enrollmentStatus !== undefined
          ? { enrollmentStatus: patch.enrollmentStatus }
          : {}),
        ...(patch.educationLevel !== undefined ? { educationLevel: patch.educationLevel } : {}),
        ...(patch.universityName !== undefined ? { universityName: patch.universityName } : {}),
        ...(patch.studentIdNumber !== undefined ? { studentIdNumber: patch.studentIdNumber } : {}),
        updatedAt: sql`now()`,
      },
    });
};

// Applies an eligibility profile patch and returns the freshly computed eligibility result.
// `status` and `reasons` are NOT writable from the patch — `parseEligibilityProfileUpdatePatch`
// rejects them with `eligibility_protected_fields` before any DB write.
export const updateStudentEligibilityProfile = async (
  userId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<{
  profile: StudentEligibilityProfileShell;
  eligibility: EligibilityResult;
}> => {
  const patch = parseEligibilityProfileUpdatePatch(payload);

  await upsertEligibilityProfile(userId, patch, db);

  const profile = await getStudentEligibilityProfile(userId, db);
  const eligibility = await checkStudentEligibility(userId, db);

  return { profile, eligibility };
};
