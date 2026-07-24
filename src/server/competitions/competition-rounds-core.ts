import { NextResponse } from "next/server";

// Validation for the rounds child collection. A save is a FULL replacement of a competition's
// stage list. sort_order is assigned from array order, never trusted from the client. Dates are
// optional per round; when both are present, ends must not precede starts.

const MAX_ROUNDS = 20;
const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PLATFORM_LABEL_LENGTH = 80;

export type CompetitionRoundInput = {
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  platformLabel: string | null;
};

type CompetitionRoundsErrorCode =
  | "competition_rounds_invalid_payload"
  | "competition_rounds_invalid_value";

export class CompetitionRoundsInputError extends Error {
  constructor(
    public readonly code: CompetitionRoundsErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
    public readonly httpStatus: number = 400,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (field: string, message: string): never => {
  throw new CompetitionRoundsInputError("competition_rounds_invalid_value", message, {
    fields: [field],
  });
};

const parseRequiredText = (field: string, value: unknown, maxLen: number): string => {
  if (typeof value !== "string") return fail(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(field, `${field} is required`);
  if (trimmed.length > maxLen) return fail(field, `${field} must be ${maxLen} characters or fewer`);
  return trimmed;
};

const parseOptionalText = (field: string, value: unknown, maxLen: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(field, `${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) return fail(field, `${field} must be ${maxLen} characters or fewer`);
  return trimmed;
};

const parseOptionalDate = (field: string, value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return fail(field, `${field} must be a datetime string or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fail(field, `${field} is not a valid datetime`);
  return date;
};

export const parseCompetitionRoundsInput = (payload: unknown): CompetitionRoundInput[] => {
  if (!isRecord(payload) || !("rounds" in payload)) {
    throw new CompetitionRoundsInputError(
      "competition_rounds_invalid_payload",
      "Payload must be an object with a rounds array",
    );
  }
  const rawRounds = payload.rounds;
  if (!Array.isArray(rawRounds)) {
    throw new CompetitionRoundsInputError(
      "competition_rounds_invalid_payload",
      "rounds must be an array",
    );
  }
  if (rawRounds.length > MAX_ROUNDS) {
    throw new CompetitionRoundsInputError(
      "competition_rounds_invalid_value",
      `A competition may have at most ${MAX_ROUNDS} rounds`,
      { fields: ["rounds"] },
    );
  }

  return rawRounds.map((raw) => {
    if (!isRecord(raw)) {
      throw new CompetitionRoundsInputError(
        "competition_rounds_invalid_value",
        "each round must be an object",
        { fields: ["rounds"] },
      );
    }
    const startsAt = parseOptionalDate("startsAt", raw.startsAt);
    const endsAt = parseOptionalDate("endsAt", raw.endsAt);
    if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
      return fail("endsAt", "endsAt must not be before startsAt");
    }
    return {
      title: parseRequiredText("title", raw.title, MAX_TITLE_LENGTH),
      description: parseOptionalText("description", raw.description, MAX_DESCRIPTION_LENGTH),
      startsAt,
      endsAt,
      platformLabel: parseOptionalText(
        "platformLabel",
        raw.platformLabel,
        MAX_PLATFORM_LABEL_LENGTH,
      ),
    };
  });
};

export const toCompetitionRoundsErrorResponse = (
  error: CompetitionRoundsInputError,
): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.httpStatus },
  );
