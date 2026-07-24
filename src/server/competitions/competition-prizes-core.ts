import { NextResponse } from "next/server";

// Validation for the prizes child collection. A save is a FULL replacement of a competition's
// prize list. Cash amounts are descriptive only (no disbursement in MVP). sort_order is assigned
// from array order, never trusted from the client.

const MAX_PRIZES = 20;
const MAX_RANK_LABEL_LENGTH = 80;
const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_CASH_AMOUNT = 1_000_000_000_000; // 1e12 — matches numeric(12,2) headroom

export type CompetitionPrizeInput = {
  rankLabel: string | null;
  title: string;
  description: string | null;
  cashAmount: string | null;
  isCertificate: boolean;
};

type CompetitionPrizesErrorCode =
  | "competition_prizes_invalid_payload"
  | "competition_prizes_invalid_value";

export class CompetitionPrizesInputError extends Error {
  constructor(
    public readonly code: CompetitionPrizesErrorCode,
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
  throw new CompetitionPrizesInputError("competition_prizes_invalid_value", message, {
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

// Accepts a number or numeric string, returns a fixed 2-decimal string for the numeric column,
// or null when blank. Rejects negatives, non-finite, and out-of-range values.
const parseOptionalCash = (field: string, value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const num =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(num)) return fail(field, `${field} must be a number`);
  if (num < 0) return fail(field, `${field} must not be negative`);
  if (num > MAX_CASH_AMOUNT) return fail(field, `${field} is too large`);
  return num.toFixed(2);
};

const parseBool = (field: string, value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") return fail(field, `${field} must be a boolean`);
  return value;
};

export const parseCompetitionPrizesInput = (payload: unknown): CompetitionPrizeInput[] => {
  if (!isRecord(payload) || !("prizes" in payload)) {
    throw new CompetitionPrizesInputError(
      "competition_prizes_invalid_payload",
      "Payload must be an object with a prizes array",
    );
  }
  const rawPrizes = payload.prizes;
  if (!Array.isArray(rawPrizes)) {
    throw new CompetitionPrizesInputError(
      "competition_prizes_invalid_payload",
      "prizes must be an array",
    );
  }
  if (rawPrizes.length > MAX_PRIZES) {
    throw new CompetitionPrizesInputError(
      "competition_prizes_invalid_value",
      `A competition may have at most ${MAX_PRIZES} prizes`,
      { fields: ["prizes"] },
    );
  }

  return rawPrizes.map((raw) => {
    if (!isRecord(raw)) {
      throw new CompetitionPrizesInputError(
        "competition_prizes_invalid_value",
        "each prize must be an object",
        { fields: ["prizes"] },
      );
    }
    const cashAmount = parseOptionalCash("cashAmount", raw.cashAmount);
    const isCertificate = parseBool("isCertificate", raw.isCertificate);
    const description = parseOptionalText("description", raw.description, MAX_DESCRIPTION_LENGTH);
    // A prize must carry at least a cash amount or a certificate — otherwise it says nothing.
    if (cashAmount === null && !isCertificate) {
      return fail("prizes", "each prize must include a cash amount or be a certificate");
    }
    return {
      rankLabel: parseOptionalText("rankLabel", raw.rankLabel, MAX_RANK_LABEL_LENGTH),
      title: parseRequiredText("title", raw.title, MAX_TITLE_LENGTH),
      description,
      cashAmount,
      isCertificate,
    };
  });
};

export const toCompetitionPrizesErrorResponse = (
  error: CompetitionPrizesInputError,
): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.httpStatus },
  );
