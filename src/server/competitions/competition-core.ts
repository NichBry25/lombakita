import { NextResponse } from "next/server";
import type { CompetitionCategory, CompetitionMode, CompetitionStatus } from "@/server/db/schema";

const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 120;
const MIN_TITLE_LENGTH = 5;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 10_000;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export const COMPETITION_STATUS_VALUES: readonly CompetitionStatus[] = [
  "draft",
  "published",
  "archived",
];

export const COMPETITION_MODE_VALUES: readonly CompetitionMode[] = ["individual", "team", "both"];

export const COMPETITION_CATEGORY_VALUES: readonly CompetitionCategory[] = [
  "technology",
  "science",
  "business",
  "creative_arts",
  "social_humanities",
  "sports",
  "academic",
  "other",
];

export const isCompetitionStatus = (value: string): value is CompetitionStatus =>
  (COMPETITION_STATUS_VALUES as readonly string[]).includes(value);

export const isCompetitionMode = (value: string): value is CompetitionMode =>
  (COMPETITION_MODE_VALUES as readonly string[]).includes(value);

export const isCompetitionCategory = (value: string): value is CompetitionCategory =>
  (COMPETITION_CATEGORY_VALUES as readonly string[]).includes(value);

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
  | "competition_not_found"
  | "competition_not_draft"
  | "competition_invalid_transition"
  | "competition_publish_validation_failed"
  | "competition_institution_not_verified"
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

// Title-derived slug normalizer. Used by the server when the caller does not supply an
// explicit slug. User-supplied slugs are validated strictly (see parseSlug) \u2014 they are not
// normalized, since the manual test contract requires rejection of uppercase, spaces, and
// special characters with a descriptive error.
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

export const SLUG_FORMAT_DESCRIPTION = `must be ${MIN_SLUG_LENGTH}\u2013${MAX_SLUG_LENGTH} characters of lowercase letters, digits, or hyphens (^[a-z0-9-]+$)`;

export type CompetitionDraftFields = {
  title?: string;
  description?: string;
  slug?: string;
  category?: CompetitionCategory | null;
  mode?: CompetitionMode | null;
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  registrationStartAt?: Date | null;
  registrationEndAt?: Date | null;
  eventStartAt?: Date | null;
  eventEndAt?: Date | null;
};

export type CompetitionCreateInput = {
  institutionSlug: string;
  title: string;
  description: string;
  slug: string | null;
  category?: CompetitionCategory | null;
  mode?: CompetitionMode | null;
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  registrationStartAt?: Date | null;
  registrationEndAt?: Date | null;
  eventStartAt?: Date | null;
  eventEndAt?: Date | null;
};

export type CompetitionPatchInput = CompetitionDraftFields;

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

// Strict slug validator for user-supplied slugs. Does not normalize: rejects with a
// descriptive error if the input contains uppercase, spaces, or non-alphanumeric/hyphen
// characters, or violates length bounds.
const parseSlug = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${fieldName} ${SLUG_FORMAT_DESCRIPTION}`,
      { fields: [fieldName] },
    );
  }
  if (value.length < MIN_SLUG_LENGTH || value.length > MAX_SLUG_LENGTH) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${fieldName} ${SLUG_FORMAT_DESCRIPTION}`,
      { fields: [fieldName] },
    );
  }
  return value;
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

const parseOptionalCategory = (value: unknown): CompetitionCategory | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !isCompetitionCategory(value)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `category must be one of: ${COMPETITION_CATEGORY_VALUES.join(", ")}`,
      { fields: ["category"] },
    );
  }
  return value;
};

const parseOptionalDescription = (value: unknown): string => {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `description must be a string up to ${MAX_DESCRIPTION_LENGTH} characters`,
      { fields: ["description"] },
    );
  }
  return value;
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

// Cross-field validation. Run on every parsed payload (create + patch). For PATCH this only
// catches inconsistencies present together in the same request; cross-field rules that span
// existing-row + payload (e.g. patching only one side of a date pair) are not enforced here —
// they belong to the publish-validation checklist for now.
const validateFieldRelations = (fields: CompetitionDraftFields): void => {
  if (
    fields.minTeamSize != null &&
    fields.maxTeamSize != null &&
    fields.minTeamSize > fields.maxTeamSize
  ) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "minTeamSize must be less than or equal to maxTeamSize",
      { fields: ["minTeamSize", "maxTeamSize"] },
    );
  }
  if (
    fields.eventStartAt != null &&
    fields.eventEndAt != null &&
    fields.eventEndAt.getTime() <= fields.eventStartAt.getTime()
  ) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "eventEndAt must be after eventStartAt",
      { fields: ["eventStartAt", "eventEndAt"] },
    );
  }
  if (
    fields.registrationStartAt != null &&
    fields.registrationEndAt != null &&
    fields.registrationEndAt.getTime() <= fields.registrationStartAt.getTime()
  ) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "registrationEndAt must be after registrationStartAt",
      { fields: ["registrationStartAt", "registrationEndAt"] },
    );
  }
  // Registration deadline must be in the future when explicitly set. Skipped when clearing
  // (null) or when not present in the payload.
  if (fields.registrationEndAt != null && fields.registrationEndAt.getTime() <= Date.now()) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "registrationEndAt must be in the future",
      { fields: ["registrationEndAt"] },
    );
  }
};

const CREATE_FIELDS: readonly string[] = [
  "institutionSlug",
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

// Fields silently stripped on input. status, institutionId, etc. cannot be set by the caller;
// they are enforced server-side. fee/featured fields are deferred (DEC-0022). Per the Step 3.2
// contract these are stripped silently rather than rejected — preserving forward compatibility
// for clients that read+resubmit a record.
const SILENT_STRIP_FIELDS: readonly string[] = [
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

const stripBlockedFields = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (SILENT_STRIP_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
};
// Drop unrecognized keys silently (per Step 3.2 contract: "Unknown fields: strip silently").
const filterToAllowed = (
  record: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in record) out[key] = record[key];
  }
  return out;
};

// Parses the subset of draft fields that are common to create + patch. Returns only the keys
// present in the payload. Fields not present are not included in the returned record.
const parseDraftFields = (
  payload: Record<string, unknown>,
  allowed: readonly string[],
): CompetitionDraftFields => {
  const fields: CompetitionDraftFields = {};
  const filtered = filterToAllowed(payload, allowed);

  if ("title" in filtered) {
    fields.title = requireString(filtered.title, "title", MIN_TITLE_LENGTH, MAX_TITLE_LENGTH);
  }
  if ("description" in filtered) {
    fields.description = parseOptionalDescription(filtered.description);
  }
  if ("slug" in filtered) {
    fields.slug = parseSlug(filtered.slug, "slug");
  }
  if ("category" in filtered) {
    fields.category = parseOptionalCategory(filtered.category);
  }
  if ("mode" in filtered) {
    fields.mode = parseOptionalMode(filtered.mode);
  }
  if ("minTeamSize" in filtered) {
    fields.minTeamSize = parseOptionalInt(filtered.minTeamSize, "minTeamSize");
  }
  if ("maxTeamSize" in filtered) {
    fields.maxTeamSize = parseOptionalInt(filtered.maxTeamSize, "maxTeamSize");
  }
  if ("registrationStartAt" in filtered) {
    fields.registrationStartAt = parseOptionalDate(
      filtered.registrationStartAt,
      "registrationStartAt",
    );
  }
  if ("registrationEndAt" in filtered) {
    fields.registrationEndAt = parseOptionalDate(filtered.registrationEndAt, "registrationEndAt");
  }
  if ("eventStartAt" in filtered) {
    fields.eventStartAt = parseOptionalDate(filtered.eventStartAt, "eventStartAt");
  }
  if ("eventEndAt" in filtered) {
    fields.eventEndAt = parseOptionalDate(filtered.eventEndAt, "eventEndAt");
  }

  validateFieldRelations(fields);
  return fields;
};

export const parseCompetitionCreateInput = (payload: unknown): CompetitionCreateInput => {
  if (!isRecord(payload)) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  // Strip API-blocked + protected fields silently (status, institutionId, feeAmount, etc.)
  const sanitized = stripBlockedFields(payload);

  const institutionSlugRaw = sanitized.institutionSlug;
  if (typeof institutionSlugRaw !== "string" || institutionSlugRaw.trim().length === 0) {
    throw new CompetitionError("competition_invalid_value", 400, "institutionSlug is required", {
      fields: ["institutionSlug"],
    });
  }

  if (sanitized.title === undefined) {
    throw new CompetitionError("competition_invalid_value", 400, "title is required", {
      fields: ["title"],
    });
  }

  const fields = parseDraftFields(sanitized, CREATE_FIELDS);
  const { title, description, slug, ...rest } = fields;

  return {
    ...rest,
    institutionSlug: institutionSlugRaw.trim().toLowerCase(),
    title: title ?? "",
    description: description ?? "",
    slug: slug ?? null,
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

  const sanitized = stripBlockedFields(payload);
  const fields = parseDraftFields(sanitized, PATCH_FIELDS);

  if (Object.keys(fields).length === 0) {
    throw new CompetitionError(
      "competition_invalid_payload",
      400,
      "At least one editable competition field is required",
    );
  }

  return fields;
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
