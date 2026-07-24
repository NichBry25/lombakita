import { NextResponse } from "next/server";

// Validation + error primitive for participant reviews. Rating is an integer 1–5; body is optional.

const MAX_BODY_LENGTH = 2000;

export type CompetitionReviewInput = {
  rating: number;
  body: string | null;
};

type CompetitionReviewErrorCode =
  | "review_invalid_payload"
  | "review_invalid_value"
  | "review_not_eligible"
  | "review_not_found";

export class CompetitionReviewError extends Error {
  constructor(
    public readonly code: CompetitionReviewErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseCompetitionReviewInput = (payload: unknown): CompetitionReviewInput => {
  if (!isRecord(payload)) {
    throw new CompetitionReviewError(
      "review_invalid_payload",
      "Review payload must be a JSON object",
    );
  }

  const rating = payload.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new CompetitionReviewError(
      "review_invalid_value",
      "rating must be an integer between 1 and 5",
      400,
      { fields: ["rating"] },
    );
  }

  let body: string | null = null;
  if (payload.body !== null && payload.body !== undefined) {
    if (typeof payload.body !== "string") {
      throw new CompetitionReviewError(
        "review_invalid_value",
        "body must be a string or null",
        400,
        {
          fields: ["body"],
        },
      );
    }
    const trimmed = payload.body.trim();
    if (trimmed.length > MAX_BODY_LENGTH) {
      throw new CompetitionReviewError(
        "review_invalid_value",
        `body must be ${MAX_BODY_LENGTH} characters or fewer`,
        400,
        { fields: ["body"] },
      );
    }
    body = trimmed.length > 0 ? trimmed : null;
  }

  return { rating, body };
};

export const toCompetitionReviewErrorResponse = (error: CompetitionReviewError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.httpStatus },
  );
