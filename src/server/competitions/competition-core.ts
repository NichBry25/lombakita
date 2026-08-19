import { NextResponse } from "next/server";
import type { CompetitionCategory, CompetitionMode, CompetitionStatus } from "@/server/db/schema";
import { COMPETITION_CATEGORY_VALUES } from "@/lib/competitions/categories";
import {
  validateCompetitionTimeline,
  type CompetitionTimelineInput,
} from "@/lib/competitions/competition-timeline";

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

export { COMPETITION_CATEGORY_VALUES };

export const isCompetitionStatus = (value: string): value is CompetitionStatus =>
  (COMPETITION_STATUS_VALUES as readonly string[]).includes(value);

export const isCompetitionMode = (value: string): value is CompetitionMode =>
  (COMPETITION_MODE_VALUES as readonly string[]).includes(value);

export const isCompetitionCategory = (value: string): value is CompetitionCategory =>
  (COMPETITION_CATEGORY_VALUES as readonly string[]).includes(value);

// Status state machine for competitions.
// draft → published   (admin only, institution must be verified, publish-validation must pass)
// published → draft   (admin-only "unpublish"; cancels every active registration)
//
// There is no archive transition. A competition that has finished stays published so its rules,
// prize terms, organizer contact details, and results remain publicly reachable after the event —
// which is what lets a participant chase an organizer who has gone quiet. How far along a
// competition is derives from its dates and its results (see deriveCompetitionPhase), never from
// a stored status.
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set(["draft->published", "published->draft"]);

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
  | "competition_recruiter_not_trusted"
  | "institution_suspended"
  | "competition_slug_taken"
  | "competition_delete_not_allowed"
  | "competition_active_registrations"
  | "competition_field_immutable"
  | "competition_post_publish_blocked"
  | "competition_unpublish_blocked_after_start"
  | "competition_unpublish_blocked_after_participation_confirmation"
  // DEC-0132: money is in flight, so withdrawing would cancel a registration someone has already
  // paid for. Escape hatch is the platform_ops cancellation route.
  | "competition_unpublish_blocked_payment_in_flight"
  // DEC-0132's sibling at the write: a price cannot move while a transfer against it is unresolved.
  | "competition_fee_change_blocked_payment_in_flight"
  // A competition that already took registrations for free cannot acquire a price: pricing it would
  // retroactively remove the right to self-cancel from candidates who never paid anything.
  | "competition_fee_blocked_free_registrations"
  // The organiser must be shown, and confirm, what the platform charges before a price goes live.
  // The confirmation is recorded; this refusal is what makes it unskippable.
  | "competition_fee_disclosure_required"
  | "competition_already_cancelled"
  | "competition_participation_not_configured"
  | "competition_participation_decision_unavailable"
  // Personal-institution reach caps.
  | "competition_personal_individual_only"
  | "competition_personal_publish_limit";

// Structured publish-validation failure surfaced to clients.
// Codes: `missing` (field is null/empty) | `out_of_order` (date pair inconsistent) |
// `not_in_future` (registration deadline in the past).
export type PublishValidationFailure = {
  field: string;
  code: "missing" | "out_of_order" | "not_in_future";
  message: string;
};

export type CompetitionErrorDetails = {
  fields?: string[];
  failures?: PublishValidationFailure[];
  // The post-publish edit fields whose change would invalidate existing
  // registrations. Surfaced so the editor can name the offending field(s) in a modal.
  blockedFields?: string[];
};

export class CompetitionError extends Error {
  constructor(
    public readonly code: CompetitionErrorCode,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 422,
    message: string,
    public readonly details?: CompetitionErrorDetails,
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
  resultAnnouncementAt?: Date | null;
  minimumParticipantEntries?: number | null;
  participantConfirmationAt?: Date | null;
  allowCancellation?: boolean;
  cancellationCutoffDays?: number | null;
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
  resultAnnouncementAt?: Date | null;
  minimumParticipantEntries?: number | null;
  participantConfirmationAt?: Date | null;
  allowCancellation?: boolean;
  cancellationCutoffDays?: number | null;
};

export type CompetitionPatchInput = CompetitionDraftFields;

export const assertCompetitionTimelineChronological = (fields: CompetitionTimelineInput): void => {
  const [error] = validateCompetitionTimeline(fields);
  if (!error) return;

  throw new CompetitionError("competition_invalid_value", 400, error.message, {
    fields: [error.relatedField, error.field],
  });
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

const parseOptionalNonNegativeInt = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `${field} must be a non-negative integer or null`,
      { fields: [field] },
    );
  }
  return value;
};

// Cancellation cutoff: nullable integer >= 0 (0 means "until the event starts"). Distinct from
// parseOptionalInt, which floors at 1.
const parseOptionalCutoffDays = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "cancellationCutoffDays must be a non-negative integer or null",
      { fields: ["cancellationCutoffDays"] },
    );
  }
  return value;
};

const parseBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new CompetitionError("competition_invalid_value", 400, `${field} must be a boolean`, {
      fields: [field],
    });
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

// Minimum team size by mode. team requires ≥ 2; individual and both require ≥ 1 (already
// enforced by parseOptionalInt). The floor for team is stricter than the general positive-int
// check, so it needs an explicit rule.
export const TEAM_MODE_MIN_SIZE = 2;
export const BOTH_MODE_MIN_SIZE = 1;
export const TEAM_MODE_DEFAULT_MAX_SIZE = 2;
export const BOTH_MODE_DEFAULT_MAX_SIZE = 2;

// Canonical team-size resolution for a given mode. This is the single source
// of truth for mode→size normalization, applied on every write path (create + patch) so a
// competition can never persist a mode that is inconsistent with its team-size columns.
//
//   individual → fixed 1/1 (no team concept)
//   both       → min is always 1 (an entrant may register solo); max is the team cap
//   team       → min/max preserved when supplied; null values filled with team defaults
//
// Keyed on null (not field-absence) so the edit form — which always sends every field, emitting
// null for an empty input — gets the same normalization as a partial create payload. This
// preserves explicitly-supplied values and only fills the nulls; it never silently raises an
// explicit team min below the floor (that is rejected by validateFieldRelations instead).
export const resolveTeamSizesForMode = (
  mode: CompetitionMode,
  min: number | null,
  max: number | null,
): { minTeamSize: number; maxTeamSize: number } => {
  if (mode === "individual") {
    return { minTeamSize: 1, maxTeamSize: 1 };
  }
  if (mode === "both") {
    return { minTeamSize: BOTH_MODE_MIN_SIZE, maxTeamSize: max ?? BOTH_MODE_DEFAULT_MAX_SIZE };
  }
  // team
  const resolvedMin = min ?? TEAM_MODE_MIN_SIZE;
  // Fill an absent max with max(resolvedMin, default) so an explicit min > default does not
  // produce a max below it.
  const resolvedMax = max ?? Math.max(resolvedMin, TEAM_MODE_DEFAULT_MAX_SIZE);
  return { minTeamSize: resolvedMin, maxTeamSize: resolvedMax };
};

// Effective-state validator for the cancellation policy pair, mirroring the DB CHECK
// (competitions_cancellation_policy_chk). Called by the service against the merged row so a
// partial PATCH that flips allowCancellation on without supplying a cutoff is rejected with a
// clean 400 instead of a raw constraint violation.
export const validateCancellationPolicy = (
  allowCancellation: boolean,
  cancellationCutoffDays: number | null,
): void => {
  if (allowCancellation && (cancellationCutoffDays === null || cancellationCutoffDays < 0)) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "cancellationCutoffDays must be a non-negative integer when allowCancellation is true",
      { fields: ["cancellationCutoffDays"] },
    );
  }
};

export type MinimumParticipationFields = {
  minimumParticipantEntries: number | null;
  participantConfirmationAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
};

// Validates minimum-participation configuration while a draft is being edited. Zero means no
// minimum. The confirmation timestamp is independent because it also closes participant
// withdrawals; when present, it sits after registration closes but strictly before the event.
export const validateMinimumParticipation = (fields: MinimumParticipationFields): void => {
  if (fields.minimumParticipantEntries !== null && fields.minimumParticipantEntries < 0) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      "minimumParticipantEntries must be a non-negative integer",
      { fields: ["minimumParticipantEntries"] },
    );
  }
  assertCompetitionTimelineChronological({
    registrationStartAt: null,
    registrationEndAt: fields.registrationEndAt,
    participantConfirmationAt: fields.participantConfirmationAt,
    eventStartAt: fields.eventStartAt,
    eventEndAt: null,
    resultAnnouncementAt: null,
  });
};

// Cross-field validation for values present together in a parsed create or patch payload.
// The service separately validates the effective stored row after applying a patch so that
// changing only one date cannot bypass these relations.
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
  // Mode-aware floor: team requires minTeamSize ≥ 2. (both/individual: parseOptionalInt
  // already guarantees ≥ 1, which covers their floor.)
  if (
    fields.mode === "team" &&
    fields.minTeamSize != null &&
    fields.minTeamSize < TEAM_MODE_MIN_SIZE
  ) {
    throw new CompetitionError(
      "competition_invalid_value",
      400,
      `team mode requires minTeamSize >= ${TEAM_MODE_MIN_SIZE}`,
      { fields: ["minTeamSize"] },
    );
  }
  assertCompetitionTimelineChronological({
    registrationStartAt: fields.registrationStartAt,
    registrationEndAt: fields.registrationEndAt,
    participantConfirmationAt: fields.participantConfirmationAt,
    eventStartAt: fields.eventStartAt,
    eventEndAt: fields.eventEndAt,
    resultAnnouncementAt: fields.resultAnnouncementAt,
  });
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
  "resultAnnouncementAt",
  "minimumParticipantEntries",
  "participantConfirmationAt",
  "allowCancellation",
  "cancellationCutoffDays",
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
  "resultAnnouncementAt",
  "minimumParticipantEntries",
  "participantConfirmationAt",
  "allowCancellation",
  "cancellationCutoffDays",
];

// Fields silently stripped on input. status, institutionId, etc. cannot be set by the caller;
// they are enforced server-side. Fee fields are deferred (DEC-0022); isFeatured is ops-managed
// and settable only through the platform-ops placement endpoint. These are stripped silently
// rather than rejected — preserving forward compatibility for clients that read+resubmit a record.
const SILENT_STRIP_FIELDS: readonly string[] = [
  "id",
  "institutionId",
  "createdByUserId",
  "status",
  "isFeatured",
  "publishedAt",
  "participationConfirmedAt",
  "cancelledAt",
  "cancellationReason",
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
// Drop unrecognized keys silently (per contract: "Unknown fields: strip silently").
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
  if ("resultAnnouncementAt" in filtered) {
    fields.resultAnnouncementAt = parseOptionalDate(
      filtered.resultAnnouncementAt,
      "resultAnnouncementAt",
    );
  }
  if ("minimumParticipantEntries" in filtered) {
    fields.minimumParticipantEntries = parseOptionalNonNegativeInt(
      filtered.minimumParticipantEntries,
      "minimumParticipantEntries",
    );
  }
  if ("participantConfirmationAt" in filtered) {
    fields.participantConfirmationAt = parseOptionalDate(
      filtered.participantConfirmationAt,
      "participantConfirmationAt",
    );
  }
  if ("allowCancellation" in filtered) {
    fields.allowCancellation = parseBoolean(filtered.allowCancellation, "allowCancellation");
  }
  if ("cancellationCutoffDays" in filtered) {
    fields.cancellationCutoffDays = parseOptionalCutoffDays(filtered.cancellationCutoffDays);
  }

  // When the payload sets mode, normalize team sizes to that mode. Fills null/absent sizes
  // with mode defaults and forces fixed values (individual 1/1, both min=1) so the stored row is
  // always internally consistent. Explicit values are preserved; an explicit sub-floor team min
  // survives here and is rejected below by validateFieldRelations.
  if (fields.mode) {
    const resolved = resolveTeamSizesForMode(
      fields.mode,
      fields.minTeamSize ?? null,
      fields.maxTeamSize ?? null,
    );
    fields.minTeamSize = resolved.minTeamSize;
    fields.maxTeamSize = resolved.maxTeamSize;
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
  validateMinimumParticipation({
    minimumParticipantEntries: fields.minimumParticipantEntries ?? null,
    participantConfirmationAt: fields.participantConfirmationAt ?? null,
    registrationEndAt: fields.registrationEndAt ?? null,
    eventStartAt: fields.eventStartAt ?? null,
  });
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

// Hard-immutable fields on a published competition.
//
// A published competition is editable in place (the update service routes it through the
// data-aware edit classifier, which decides per field whether a change is refused, notifies
// participants, or is silent). These three fields sit OUTSIDE that classifier: they are the
// participant contract participants registered under and can never change while published.
// The update service enforces this as the outer layer (422 competition_field_immutable) before
// the classifier runs. Draft competitions edit all fields freely.
//
//   mode             (registrations are anchored to the mode contract)
//   minTeamSize      (team registration sizing locked in at publish)
//   maxTeamSize      (team registration sizing locked in at publish)
export const IMMUTABLE_AFTER_PUBLISH: readonly string[] = [
  "mode",
  "minTeamSize",
  "maxTeamSize",
  "minimumParticipantEntries",
  "participantConfirmationAt",
];

// Publish-validation checklist. A competition can only transition draft → published if every
// required field is set, the registration deadline is in the future, and the full timeline is
// ordered: registrationStart < registrationEnd <= participantConfirmation < eventStart
// < eventEnd <= resultAnnouncement.
//
// Eligibility note: the publish contract lists "at least one eligibility criterion" as a
// required publish input, but the competition schema does not model eligibility. Skipping
// this check is intentional and tracked as known debt; do not invent a placeholder field.
//
// Returns a structured `PublishValidationResult`. `passed` reflects whether the candidate
// could publish; `failures` lists every issue (missing fields and date-coherence breaks)
// rather than short-circuiting on the first one — the institution should be able to fix
// everything in one editing pass.
export type PublishValidationCandidate = {
  title: string;
  description: string;
  category: CompetitionCategory | null;
  mode: CompetitionMode | null;
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  registrationStartAt: Date | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
  resultAnnouncementAt?: Date | null;
  minimumParticipantEntries?: number | null;
  participantConfirmationAt?: Date | null;
};

export type PublishValidationResult = {
  passed: boolean;
  failures: PublishValidationFailure[];
};

const PUBLISH_REQUIRED_DATE_FIELDS = [
  "registrationStartAt",
  "registrationEndAt",
  "eventStartAt",
  "eventEndAt",
  "resultAnnouncementAt",
] as const;

const isNonEmpty = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

// The fields a competition cannot be published without. Split out from the full checklist so the
// published-edit path can reuse it: an edit must not strip a field publishing required, but the
// ordering and future-dated rules below are publish-time judgements and must NOT be re-applied on
// edit — a finished competition's registration deadline is necessarily in the past, and
// re-checking it would make every finished competition uneditable.
export const findMissingPublishFields = (
  candidate: PublishValidationCandidate,
): PublishValidationFailure[] => {
  const failures: PublishValidationFailure[] = [];

  if (!isNonEmpty(candidate.title)) {
    failures.push({ field: "title", code: "missing", message: "title is required to publish" });
  }
  if (!isNonEmpty(candidate.description)) {
    failures.push({
      field: "description",
      code: "missing",
      message: "description is required to publish",
    });
  }
  if (!candidate.mode) {
    failures.push({ field: "mode", code: "missing", message: "mode is required to publish" });
  }
  if (!candidate.category) {
    failures.push({
      field: "category",
      code: "missing",
      message: "category is required to publish",
    });
  }
  for (const field of PUBLISH_REQUIRED_DATE_FIELDS) {
    if (!candidate[field]) {
      failures.push({ field, code: "missing", message: `${field} is required to publish` });
    }
  }
  if (!candidate.participantConfirmationAt) {
    failures.push({
      field: "participantConfirmationAt",
      code: "missing",
      message: "participantConfirmationAt is required to publish",
    });
  }

  return failures;
};

export const validatePublishChecklist = (
  candidate: PublishValidationCandidate,
): PublishValidationResult => {
  const failures: PublishValidationFailure[] = findMissingPublishFields(candidate);

  // Mode-aware size floor validation at publish time.
  if (candidate.mode === "team" && (candidate.minTeamSize ?? 0) < TEAM_MODE_MIN_SIZE) {
    failures.push({
      field: "minTeamSize",
      code: "missing",
      message: `team mode requires minTeamSize >= ${TEAM_MODE_MIN_SIZE}`,
    });
  }
  if (
    candidate.minTeamSize != null &&
    candidate.maxTeamSize != null &&
    candidate.minTeamSize > candidate.maxTeamSize
  ) {
    failures.push({
      field: "maxTeamSize",
      code: "out_of_order",
      message: "minTeamSize must be less than or equal to maxTeamSize",
    });
  }
  failures.push(
    ...validateCompetitionTimeline({
      registrationStartAt: candidate.registrationStartAt,
      registrationEndAt: candidate.registrationEndAt,
      participantConfirmationAt: candidate.participantConfirmationAt,
      eventStartAt: candidate.eventStartAt,
      eventEndAt: candidate.eventEndAt,
      resultAnnouncementAt: candidate.resultAnnouncementAt,
    }).map((error) => ({
      field: error.field,
      code: "out_of_order" as const,
      message: error.message,
    })),
  );
  if (candidate.registrationEndAt && candidate.registrationEndAt.getTime() <= Date.now()) {
    failures.push({
      field: "registrationEndAt",
      code: "not_in_future",
      message: "registrationEndAt must be in the future at publish time",
    });
  }

  return { passed: failures.length === 0, failures };
};
