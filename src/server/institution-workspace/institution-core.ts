import { NextResponse } from "next/server";
import type {
  InstitutionMembershipRole,
  InstitutionMembershipStatus,
  InstitutionStatus,
} from "@/server/db/schema";

const MIN_DISPLAY_NAME_LENGTH = 2;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 64;
const FALLBACK_SLUG_BASE = "institusi";

const CREATE_FIELDS = ["displayName", "slug"] as const;
const UPDATE_FIELDS = ["displayName", "slug"] as const;

const PROTECTED_FIELDS = [
  "id",
  "institutionId",
  "status",
  "membershipRole",
  "membershipStatus",
  "ownerUserId",
  "createdAt",
  "updatedAt",
] as const;

type CreateField = (typeof CREATE_FIELDS)[number];
type UpdateField = (typeof UPDATE_FIELDS)[number];
type ProtectedField = (typeof PROTECTED_FIELDS)[number];

const createFieldSet = new Set<string>(CREATE_FIELDS);
const updateFieldSet = new Set<string>(UPDATE_FIELDS);
const protectedFieldSet = new Set<string>(PROTECTED_FIELDS);

export type InstitutionWorkspaceShell = {
  institutionId: string;
  displayName: string;
  slug: string;
  status: InstitutionStatus;
  ownerMembership: {
    membershipId: string;
    membershipRole: InstitutionMembershipRole;
    membershipStatus: InstitutionMembershipStatus;
    joinedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
};

export type InstitutionWorkspaceCreateInput = {
  displayName: string;
  slug: string | null;
};

export type InstitutionWorkspaceSettingsPatch = {
  displayName?: string;
  slug?: string;
};

type InstitutionWorkspaceInputErrorCode =
  | "institution_invalid_payload"
  | "institution_invalid_fields"
  | "institution_protected_fields"
  | "institution_invalid_value";

export class InstitutionWorkspaceInputError extends Error {
  constructor(
    public readonly code: InstitutionWorkspaceInputErrorCode,
    message: string,
    public readonly details?: {
      fields?: string[];
    },
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseDisplayName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "displayName must be a string between 2 and 160 characters",
      { fields: ["displayName"] },
    );
  }

  const normalized = value.trim();

  if (normalized.length < MIN_DISPLAY_NAME_LENGTH || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "displayName must be a string between 2 and 160 characters",
      { fields: ["displayName"] },
    );
  }

  return normalized;
};

const parseSlug = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "slug must be a string with 3 to 64 URL-safe characters",
      { fields: ["slug"] },
    );
  }

  const normalized = normalizeInstitutionSlug(value);

  if (normalized.length < MIN_SLUG_LENGTH || normalized.length > MAX_SLUG_LENGTH) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "slug must be a string with 3 to 64 URL-safe characters",
      { fields: ["slug"] },
    );
  }

  return normalized;
};

export const normalizeInstitutionSlug = (value: string): string => {
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

export const deriveInstitutionSlugBase = (displayName: string): string => {
  const derived = normalizeInstitutionSlug(displayName);

  if (derived.length >= MIN_SLUG_LENGTH) {
    return derived;
  }

  return FALLBACK_SLUG_BASE;
};

export const buildInstitutionSlugCandidate = (baseSlug: string, attempt: number): string => {
  if (attempt <= 0) {
    return baseSlug;
  }

  const suffix = `-${attempt + 1}`;
  const maxBaseLength = Math.max(MIN_SLUG_LENGTH, MAX_SLUG_LENGTH - suffix.length);
  const constrainedBase = baseSlug.slice(0, maxBaseLength).replace(/-+$/g, "");
  const safeBase = constrainedBase.length >= MIN_SLUG_LENGTH ? constrainedBase : FALLBACK_SLUG_BASE;

  return `${safeBase}${suffix}`;
};

const assertPayloadShape = (
  payload: unknown,
  editableFields: Set<string>,
): Record<string, unknown> => {
  if (!isRecord(payload)) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_payload",
      "Institution payload must be a JSON object",
    );
  }

  const payloadKeys = Object.keys(payload);

  if (payloadKeys.length === 0) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_payload",
      "At least one editable institution field is required",
    );
  }

  const protectedFields = payloadKeys.filter((key) => protectedFieldSet.has(key));

  if (protectedFields.length > 0) {
    throw new InstitutionWorkspaceInputError(
      "institution_protected_fields",
      "Some fields cannot be modified through this institution endpoint",
      {
        fields: protectedFields,
      },
    );
  }

  const invalidFields = payloadKeys.filter((key) => !editableFields.has(key));

  if (invalidFields.length > 0) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_fields",
      "Payload contains unsupported institution fields",
      {
        fields: invalidFields,
      },
    );
  }

  return payload;
};

export const parseInstitutionWorkspaceCreateInput = (
  payload: unknown,
): InstitutionWorkspaceCreateInput => {
  const record = assertPayloadShape(payload, createFieldSet);

  if (!("displayName" in record)) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "displayName is required",
      { fields: ["displayName"] },
    );
  }

  const displayName = parseDisplayName(record.displayName);
  const slug = "slug" in record ? parseSlug(record.slug) : null;

  return {
    displayName,
    slug,
  };
};

export const parseInstitutionWorkspaceSettingsPatch = (
  payload: unknown,
): InstitutionWorkspaceSettingsPatch => {
  const record = assertPayloadShape(payload, updateFieldSet);
  const patch: InstitutionWorkspaceSettingsPatch = {};

  if ("displayName" in record) {
    patch.displayName = parseDisplayName(record.displayName);
  }

  if ("slug" in record) {
    patch.slug = parseSlug(record.slug);
  }

  return patch;
};

export const parseInstitutionSlugParam = (value: string): string => {
  const normalized = normalizeInstitutionSlug(value);

  if (normalized.length < MIN_SLUG_LENGTH || normalized.length > MAX_SLUG_LENGTH) {
    throw new InstitutionWorkspaceInputError(
      "institution_invalid_value",
      "institutionSlug must be a valid institution slug",
      {
        fields: ["institutionSlug"],
      },
    );
  }

  return normalized;
};

export const toInstitutionWorkspaceInputErrorResponse = (
  error: InstitutionWorkspaceInputError,
): NextResponse => {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    },
    { status: 400 },
  );
};

export const INSTITUTION_WORKSPACE_CREATE_FIELDS: readonly CreateField[] = CREATE_FIELDS;
export const INSTITUTION_WORKSPACE_UPDATE_FIELDS: readonly UpdateField[] = UPDATE_FIELDS;
export const INSTITUTION_WORKSPACE_PROTECTED_FIELDS: readonly ProtectedField[] = PROTECTED_FIELDS;
