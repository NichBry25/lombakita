import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-eligibility-service");

import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions } from "@/server/db/schema";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";

const MAX_ELIGIBILITY_LENGTH = 2000;

type EligibilityErrorCode =
  | "competition_eligibility_invalid_payload"
  | "competition_eligibility_invalid_value";

export class CompetitionEligibilityInputError extends Error {
  constructor(
    public readonly code: EligibilityErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
  }
}

// Pure parser: extracts a nullable eligibility note (blank → null, capped length). The note is
// descriptive only and never gates registration (open candidacy, DEC-0106).
export const parseEligibilityNote = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CompetitionEligibilityInputError(
      "competition_eligibility_invalid_payload",
      "Payload must be a JSON object",
    );
  }
  const value = (payload as { eligibilityNote?: unknown }).eligibilityNote;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new CompetitionEligibilityInputError(
      "competition_eligibility_invalid_value",
      "eligibilityNote must be a string or null",
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_ELIGIBILITY_LENGTH) {
    throw new CompetitionEligibilityInputError(
      "competition_eligibility_invalid_value",
      `eligibilityNote must be ${MAX_ELIGIBILITY_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
};

export const getCompetitionEligibilityForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<string | null> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const [row] = await db
    .select({ eligibilityNote: competitions.eligibilityNote })
    .from(competitions)
    .where(eq(competitions.id, competition.id));
  return row?.eligibilityNote ?? null;
};

export const setCompetitionEligibilityForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<string | null> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const eligibilityNote = parseEligibilityNote(payload);
  await db
    .update(competitions)
    .set({ eligibilityNote, updatedAt: sql`now()` })
    .where(eq(competitions.id, competition.id));
  return eligibilityNote;
};
