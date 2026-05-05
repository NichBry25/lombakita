import { NextResponse } from "next/server";
import type { CompetitionMode, CompetitionStatus } from "@/server/db/schema";

const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 64;
const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_CATEGORY_LENGTH = 80;

export const COMPETITION_STATUS_VALUES: readonly CompetitionStatus[] = [
  "draft",
  "published",
  "archived",
];

export const COMPETITION_MODE_VALUES: readonly CompetitionMode[] = ["individual", "team", "both"];

export const isCompetitionStatus = (value: string): value is CompetitionStatus =>
  (COMPETITION_STATUS_VALUES as readonly string[]).includes(value);

export const isCompetitionMode = (value: string): value is CompetitionMode =>
  (COMPETITION_MODE_VALUES as readonly string[]).includes(value);

// Status state machine for competitions.
// draft → published   (admin only, institution must be verified, publish-validation must pass)
// draft → archived    (admin only)
// published → draft   (admin-only "unpublish"; gated by hasActiveRegistrations stub)
// published → archived (admin only)
// archived is terminal — no transitions out.
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  "draft->published",
  "draft->archived",
  "published->draft",
  "published->archived",
]);

const transitionKey = (from: CompetitionStatus, to: CompetitionStatus): string => `${from}->${to}`;

export const isAllowedStatusTransition = (
  from: CompetitionStatus,
  to: CompetitionStatus,
): boolean => ALLOWED_TRANSITIONS.has(transitionKey(from, to));

type CompetitionErrorCode =
  | "competition_invalid_payload"
  | "competition_invalid_value"
  | "competition_invalid_fields"
  | "competition_protected_fields"
  | "competition_not_found"
  | "competition_invalid_transition"
  | "competition_publish_validation_failed"
  | "competition_institution_not_verified"
  | "competition_field_locked"
  | "competition_slug_taken"
  | "competition_delete_not_allowed"
  | "competition_active_registrations";

export class CompetitionError extends Error {
  constructor(
    public readonly code: CompetitionErrorCode,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 422,
    message: string,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

export const toCompetitionErrorResponse = (error: CompetitionError): NextResponse => {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    { status: error.httpStatus },
  );
};

export const normalizeCompetitionSlug = (value: string): string => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (normalized.length <= MAX_SLUG_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
};

export type CompetitionCreateInput = {
  institutionSlug: string;
  title: string;
  description: string;
  slug: string | null;
};

export type CompetitionPatchInput = {
  title?: string;
  description?: string;
  slug?: string;
  category?: string | null;
  mode?: CompetitionMode | null;
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  registrationStartAt?: Date | null;
  registrationEndAt?: Date | null;
  eventStartAt?: Date | null;
  eventEndAt?: Date | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string, min: number, max: number): string => {
  if (typeof value !== "string") {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be a string between ${min} and ${max} characters`,
      { fields: [field] },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be a string between ${min} and ${max} characters`,
      { fields: [field] },
    );
  }
  return trimmed;
};

const parseSlug = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string") {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${fieldName} must be URL-safe (3 to 64 characters)`,
      { fields: [fieldName] },
    );
  }
  const normalized = normalizeCompetitionSlug(value);
  if (normalized.length < MIN_SLUG_LENGTH || normalized.length > MAX_SLUG_LENGTH) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${fieldName} must be URL-safe (3 to 64 characters)`,
      { fields: [fieldName] },
    );
  }
  return normalized;
};

const parseOptionalDate = (value: unknown, field: string): Date | null => {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be an ISO-8601 date string or null`,
      { fields: [field] },
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be an ISO-8601 date string or null`,
      { fields: [field] },
    );
  }
  return date;
};

const parseOptionalInt = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be a positive integer or null`,
      { fields: [field] },
    );
  }
  return value;
};

const parseOptionalMode = (value: unknown): CompetitionMode | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !isCompetitionMode(value)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `mode must be one of: ${COMPETITION_MODE_VALUES.join(", ")}`,
      { fields: ["mode"] },
    );
  }
  return value;
};

const CREATE_FIELDS: readonly string[] = ["institutionSlug", "title", "description", "slug"];
export const PATCH_FIELDS: readonly string[] = [
  "title",
  "description",
  "slug",
  "category",
  "mode",
  "minTeamSize",
  "maxTeamSize",
  "registrationStartAt",
  "registrationEndAt",
  "eventStartAt",
  "eventEndAt",
];
const PROTECTED_FIELDS: readonly string[] = [
  "id",
  "institutionId",
  "createdByUserId",
  "status",
  "isFeatured",
  "publishedAt",
  "archivedAt",
  "deletedAt",
  "createdAt",
  "updatedAt",
  "feeAmount",
  "feeCurrency",
];

const guardEditableFields = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const keys = Object.keys(record);
  const protectedFields = keys.filter((k) => PROTECTED_FIELDS.includes(k));
  if (protectedFields.length > 0) {
    throw new CompetitionError(
      "competition_protected_fields",
      400,
      "Some fields cannot be modified through this endpoint",
      { fields: protectedFields },
    );
  }
  const invalidFields = keys.filter((k) => !allowed.includes(k));
  if (invalidFields.length > 0) {
    throw new CompetitionError(
      "competition_invalid_fields",
      400,
      "Payload contains unsupported competition fields",
      { fields: invalidFields },
    );
  }
};

export const parseCompetitionCreateInput = (payload: unknown): CompetitionCreateInput => {
  if (!isRecord(payload)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }
  guardEditableFields(payload, CREATE_FIELDS);

  const institutionSlugRaw = payload.institutionSlug;
  if (typeof institutionSlugRaw !== "string" || institutionSlugRaw.trim().length === 0) {
    throw new CompetitionError("competition_invalid_value", 400, "institutionSlug is required", {
      fields: ["institutionSlug"],
    });
  }

  const title = requireString(payload.title, "title", MIN_TITLE_LENGTH, MAX_TITLE_LENGTH);
  let description = "";
  if (payload.description !== undefined) {
    if (
      typeof payload.description !== "string" ||
      payload.description.length > MAX_DESCRIPTION_LENGTH
    ) {
      throw new CompetitionError(
        "competition_invalid_value",
        400,
        `description must be a string up to ${MAX_DESCRIPTION_LENGTH} characters`,
        { fields: ["description"] },
      );
    }
    description = payload.description;
  }

  const slug = "slug" in payload && payload.slug !== null ? parseSlug(payload.slug, "slug") : null;

  return {
    institutionSlug: institutionSlugRaw.trim().toLowerCase(),
    title,
    description,
    slug,
  };
};

export const parseCompetitionPatchInput = (payload: unknown): CompetitionPatchInput => {
  if (!isRecord(payload)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }
  guardEditableFields(payload, PATCH_FIELDS);
  if (Object.keys(payload).length === 0) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "At least one editable competition field is required",
    );
  }

  const patch: CompetitionPatchInput = {};

  if ("title" in payload) {
    patch.title = requireString(payload.title, "title", MIN_TITLE_LENGTH, MAX_TITLE_LENGTH);
  }
  if ("description" in payload) {
    if (
      typeof payload.description !== "string" ||
      payload.description.length > MAX_DESCRIPTION_LENGTH
    ) {
      throw new CompetitionError(
        "competition_invalid_value",
        400,
        `description must be a string up to ${MAX_DESCRIPTION_LENGTH} characters`,
        { fields: ["description"] },
      );
    }
    patch.description = payload.description;
  }
  if ("slug" in payload) {
    patch.slug = parseSlug(payload.slug, "slug");
  }
  if ("category" in payload) {
    if (payload.category === null) {
      patch.category = null;
    } else if (
      typeof payload.category !== "string" ||
      payload.category.trim().length === 0 ||
      payload.category.length > MAX_CATEGORY_LENGTH
    ) {
      throw new CompetitionError(
        "competition_invalid_value",
        400,
        `category must be a non-empty string up to ${MAX_CATEGORY_LENGTH} characters or null`,
        { fields: ["category"] },
      );
    } else {
      patch.category = payload.category.trim();
    }
  }
  if ("mode" in payload) {
    patch.mode = parseOptionalMode(payload.mode);
  }
  if ("minTeamSize" in payload) {
    patch.minTeamSize = parseOptionalInt(payload.minTeamSize, "minTeamSize");
  }
  if ("maxTeamSize" in payload) {
    patch.maxTeamSize = parseOptionalInt(payload.maxTeamSize, "maxTeamSize");
  }
  if ("registrationStartAt" in payload) {
    patch.registrationStartAt = parseOptionalDate(
      payload.registrationStartAt,
      "registrationStartAt",
    );
  }
  if ("registrationEndAt" in payload) {
    patch.registrationEndAt = parseOptionalDate(payload.registrationEndAt, "registrationEndAt");
  }
  if ("eventStartAt" in payload) {
    patch.eventStartAt = parseOptionalDate(payload.eventStartAt, "eventStartAt");
  }
  if ("eventEndAt" in payload) {
    patch.eventEndAt = parseOptionalDate(payload.eventEndAt, "eventEndAt");
  }

  return patch;
};

export type StatusTransitionInput = { targetStatus: CompetitionStatus };

export const parseStatusTransitionInput = (payload: unknown): StatusTransitionInput => {
  if (!isRecord(payload)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }
  const targetStatus = payload.targetStatus;
  if (typeof targetStatus !== "string" || !isCompetitionStatus(targetStatus)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      `targetStatus must be one of: ${COMPETITION_STATUS_VALUES.join(", ")}`,
      { fields: ["targetStatus"] },
    );
  }
  return { targetStatus };
};

// Publish-validation checklist. A competition can only transition draft → published
// if title and description are non-empty, mode is set, and at least one date field is non-null.
// Returns the list of missing fields. Empty list means the draft is publishable.
export type PublishValidationCandidate = {
  title: string;
  description: string;
  mode: CompetitionMode | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
};

export const validatePublishChecklist = (candidate: PublishValidationCandidate): string[] => {
  const missing: string[] = [];
  if (!candidate.title || candidate.title.trim().length === 0) missing.push("title");
  if (!candidate.description || candidate.description.trim().length === 0)
    missing.push("description");
  if (!candidate.mode) missing.push("mode");
  const hasAnyDate =
    candidate.registrationStartAt !== null ||
    candidate.registrationEndAt !== null ||
    candidate.eventStartAt !== null ||
    candidate.eventEndAt !== null;
  if (!hasAnyDate) missing.push("dates");
  return missing;
};
