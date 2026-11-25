import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-eligibility-service");

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, type CompetitionAudience } from "@/server/db/schema";
import {
  assertCompetitionAccess,
  assertPublicFieldsUnchangedByRemovedHost,
  type CompetitionRow,
} from "@/server/competitions/competition-access";
import { CompetitionError } from "@/server/competitions/competition-core";
import { isCompetitionAudience, normalizeAudience } from "@/lib/competitions/audiences";
import {
  COMPETITION_AUDIENCE_CANNOT_BE_EMPTIED_REASON,
  COMPETITION_CHANGED_DURING_EDIT_REASON,
} from "@/lib/competitions/publish-locks";

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
// alone, so a client that does not send the audience cannot wipe it. An empty list and null
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

// Decided in the WHERE of the write and not from an earlier read, so a competition that was
// published or given an audience between two requests cannot have its audience emptied.
const audienceMayBeEmptied = or(
  eq(competitions.status, "draft"),
  isNull(competitions.audience),
  sql`cardinality(${competitions.audience}) = 0`,
);

const buildRefusalForUnsavedEligibility = async (
  competitionId: string,
  isEmptyingAudience: boolean,
  db: Database,
): Promise<CompetitionError> => {
  if (isEmptyingAudience) {
    const [row] = await db
      .select({ status: competitions.status, audience: competitions.audience })
      .from(competitions)
      .where(eq(competitions.id, competitionId));
    const isSetAudienceOnLiveCompetition =
      row !== undefined &&
      row.status !== "draft" &&
      row.audience !== null &&
      row.audience.length > 0;
    if (isSetAudienceOnLiveCompetition) {
      return new CompetitionError(
        "competition_audience_cannot_be_emptied",
        409,
        COMPETITION_AUDIENCE_CANNOT_BE_EMPTIED_REASON,
      );
    }
  }
  return new CompetitionError(
    "competition_changed_during_edit",
    409,
    COMPETITION_CHANGED_DURING_EDIT_REASON,
  );
};

// The eligibility note and the audience are public on a live competition, so a host whose trust
// staff removed keeps them as they are there. A save that resends the stored values goes through.
// The note is written on every save, so it is compared on every save. The audience is compared only
// when the save carries it.
const assertEligibilityUnchangedByRemovedHost = async (
  actorUserId: string,
  competition: CompetitionRow,
  eligibilityNote: string | null,
  audience: CompetitionAudience[] | null | undefined,
  db: Database,
): Promise<void> => {
  if (competition.status !== "published") return;
  const [stored] = await db
    .select({ eligibilityNote: competitions.eligibilityNote, audience: competitions.audience })
    .from(competitions)
    .where(eq(competitions.id, competition.id));
  const changedFields: string[] = [];
  const storedNote = stored?.eligibilityNote ?? null;
  if (eligibilityNote !== storedNote) changedFields.push("eligibilityNote");
  const storedAudienceKey = (stored?.audience ?? []).join(",");
  const nextAudienceKey = (audience ?? []).join(",");
  const audienceChanges = audience !== undefined && storedAudienceKey !== nextAudienceKey;
  if (audienceChanges) changedFields.push("audience");
  await assertPublicFieldsUnchangedByRemovedHost(actorUserId, changedFields, db);
};

export const setCompetitionEligibilityForEditor = async (
  actorUserId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionEligibilityFields> => {
  const { competition } = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  const eligibilityNote = parseEligibilityNote(payload);
  const audience = parseEligibilityAudience(payload);
  const isEmptyingAudience = audience === null;
  await assertEligibilityUnchangedByRemovedHost(
    actorUserId,
    competition,
    eligibilityNote,
    audience,
    db,
  );

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
        isEmptyingAudience ? audienceMayBeEmptied : undefined,
      ),
    )
    .returning({ eligibilityNote: competitions.eligibilityNote, audience: competitions.audience });

  if (!saved) {
    throw await buildRefusalForUnsavedEligibility(competition.id, isEmptyingAudience, db);
  }
  return saved;
};
