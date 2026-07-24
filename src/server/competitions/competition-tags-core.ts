import { NextResponse } from "next/server";
import { ALLOWED_COMPETITION_TAGS } from "@/lib/competitions/tags";

const allowedTagSet = new Set<string>(ALLOWED_COMPETITION_TAGS);

type CompetitionTagsErrorCode =
  | "competition_tags_invalid_payload"
  | "competition_tags_invalid_value";

export class CompetitionTagsInputError extends Error {
  constructor(
    public readonly code: CompetitionTagsErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

export const parseCompetitionTagsInput = (payload: unknown): string[] => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("tags" in payload)
  ) {
    throw new CompetitionTagsInputError(
      "competition_tags_invalid_payload",
      "Payload must be an object with a tags array",
    );
  }
  const rawTags = (payload as { tags: unknown }).tags;
  if (!Array.isArray(rawTags)) {
    throw new CompetitionTagsInputError(
      "competition_tags_invalid_payload",
      "tags must be an array",
    );
  }

  const seen = new Set<string>();
  for (const tag of rawTags) {
    if (typeof tag !== "string" || !allowedTagSet.has(tag)) {
      throw new CompetitionTagsInputError(
        "competition_tags_invalid_value",
        "Each tag must be one of the allowed values",
        400,
        { fields: ["tags"] },
      );
    }
    seen.add(tag);
  }
  return [...seen];
};

export const toCompetitionTagsErrorResponse = (error: CompetitionTagsInputError): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.httpStatus },
  );
