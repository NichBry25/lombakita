import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-eligibility-service");

import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, type CompetitionAudience } from "@/server/db/schema";
import { assertCompetitionAccess } from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { isCompetitionAudience, normalizeAudience } from "@/lib/competitions/audiences";
import { COMPETITION_CHANGED_DURING_EDIT_REASON } from "@/lib/competitions/publish-locks";

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

export type CompetitionEligibilityFields = {
  eligibilityNote: string | null;
  audience: CompetitionAudience[] | null;
};

const assertPayloadIsJsonObject = (payload: unknown): void => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CompetitionEligibilityInputError(
      "competition_eligibility_invalid_payload",
      "Payload must be a JSON object",
    );
  }
};

// Pure parser: extracts a nullable eligibility note (blank → null, capped length). The note is
// descriptive only and never gates registration (open candidacy, DEC-0106).
export const parseEligibilityNote = (payload: unknown): string | null => {
  assertPayloadIsJsonObject(payload);
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

// Pure parser: undefined when the payload has no audience key, which leaves the stored audience
// alone so an editor tab opened before this field existed cannot wipe it. An empty list and null
// both mean "empty" and parse to null. Duplicates drop and the order is the fixed display order.
// The audience is a label only and never gates registration (DEC-0106).
export const parseEligibilityAudience = (
  payload: unknown,
): CompetitionAudience[] | null | undefined => {
  assertPayloadIsJsonObject(payload);
  const value = (payload as { audience?: unknown }).audience;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every(isCompetitionAudience)) {
    throw new CompetitionEligibilityInputError(
      "competition_eligibility_invalid_value",
      "audience must be a list of known audience values or null",
    );
  }
  return normalizeAudience(value);
};

export const getCompetitionEligibilityForEditor = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionEligibilityFields> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const [row] = await db
    .select({ eligibilityNote: competitions.eligibilityNote, audience: competitions.audience })
    .from(competitions)
    .where(eq(competitions.id, competition.id));
  return { eligibilityNote: row?.eligibilityNote ?? null, audience: row?.audience ?? null };
};

const loadStoredAudience = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionAudience[] | null> => {
  const [row] = await db
    .select({ audience: competitions.audience })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row?.audience ?? null;
};

// A set audience can be emptied on a draft only. The write then names status = 'draft', so a
// competition published after the status was read matches nothing instead of going live empty.
const isEmptyingASetAudience = (
  requested: CompetitionAudience[] | null | undefined,
  stored: CompetitionAudience[] | null,
): boolean => requested === null && stored !== null && stored.length > 0;

export const setCompetitionEligibilityForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionEligibilityFields> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const eligibilityNote = parseEligibilityNote(payload);
  const audience = parseEligibilityAudience(payload);
  const storedAudience = await loadStoredAudience(competition.id, db);
  const draftOnly = isEmptyingASetAudience(audience, storedAudience);

  const [saved] = await db
    .update(competitions)
    .set({
      eligibilityNote,
      ...(audience !== undefined && { audience }),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(competitions.id, competition.id),
        draftOnly ? eq(competitions.status, "draft") : undefined,
      ),
    )
    .returning({ eligibilityNote: competitions.eligibilityNote, audience: competitions.audience });

  if (!saved) {
    throw new CompetitionError(
      "competition_changed_during_edit",
      409,
      COMPETITION_CHANGED_DURING_EDIT_REASON,
    );
  }
  return saved;
};
