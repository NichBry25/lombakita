import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/candidate/candidate-profile-service");

import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { candidateProfiles, type CandidateOccupation } from "@/server/db/schema";
import type {
  CandidateProfileInput,
  CandidateProfileUpdatePatch,
} from "@/server/candidate/candidate-profile-core";

export type CandidateProfileRow = {
  userId: string;
  fullName: string;
  phoneNumber: string;
  occupation: CandidateOccupation;
  dateOfBirth: string;
  createdAt: Date;
  updatedAt: Date;
};

const selectColumns = {
  userId: candidateProfiles.userId,
  fullName: candidateProfiles.fullName,
  phoneNumber: candidateProfiles.phoneNumber,
  occupation: candidateProfiles.occupation,
  dateOfBirth: candidateProfiles.dateOfBirth,
  createdAt: candidateProfiles.createdAt,
  updatedAt: candidateProfiles.updatedAt,
};

// Returns the candidate's onboarding profile, or null when none exists. Never returns another
// user's row; the caller must scope userId to the authenticated session.
export const getCandidateProfile = async (
  userId: string,
  db: Database = getDb(),
): Promise<CandidateProfileRow | null> => {
  const [row] = await db
    .select(selectColumns)
    .from(candidateProfiles)
    .where(eq(candidateProfiles.userId, userId))
    .limit(1);

  return row ?? null;
};

// Inserts the candidate onboarding profile. Intended to run inside the registration transaction
// (`tx`) so the profile and the candidate verification grant land atomically. Idempotent on the
// re-registration-into-unverified path: an existing row is left untouched.
export const insertCandidateProfileInTransaction = async (
  tx: Database,
  userId: string,
  input: CandidateProfileInput,
): Promise<void> => {
  await tx
    .insert(candidateProfiles)
    .values({
      userId,
      fullName: input.fullName,
      phoneNumber: input.phoneNumber,
      occupation: input.occupation,
      dateOfBirth: input.dateOfBirth,
    })
    .onConflictDoUpdate({
      target: candidateProfiles.userId,
      set: {
        fullName: input.fullName,
        phoneNumber: input.phoneNumber,
        occupation: input.occupation,
        dateOfBirth: input.dateOfBirth,
        updatedAt: sql`now()`,
      },
    });
};

// Applies a partial edit from the /candidate-dashboard editor. Returns the updated row, or null
// when no candidate profile exists for the user.
export const updateCandidateProfile = async (
  userId: string,
  patch: CandidateProfileUpdatePatch,
  db: Database = getDb(),
): Promise<CandidateProfileRow | null> => {
  const [updated] = await db
    .update(candidateProfiles)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(candidateProfiles.userId, userId))
    .returning(selectColumns);

  return updated ?? null;
};
