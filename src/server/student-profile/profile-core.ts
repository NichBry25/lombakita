import { NextResponse } from "next/server";

const MIN_DISPLAY_NAME_LENGTH = 2;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_HEADLINE_LENGTH = 160;
const PHONE_PATTERN = /^\+?[0-9]{8,16}$/;

const EDITABLE_FIELDS = ["displayName", "phoneNumber", "headline"] as const;

const PROTECTED_FIELDS = [
  "id",
  "userId",
  "email",
  "emailVerified",
  "role",
  "status",
  "membershipRole",
  "membershipStatus",
  "institutionId",
  "platformRoles",
  "createdAt",
  "updatedAt",
  "image",
  "avatarUrl",
  "name",
  "summary",
] as const;

const editableFieldSet = new Set<string>(EDITABLE_FIELDS);
const protectedFieldSet = new Set<string>(PROTECTED_FIELDS);

export type StudentProfileShell = {
  userId: string;
  email: string;
  displayName: string | null;
  phoneNumber: string | null;
  headline: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type StudentProfileUpdatePatch = {
  displayName?: string;
  phoneNumber?: string | null;
  headline?: string | null;
};

type StudentProfileInputErrorCode =
  | "profile_invalid_payload"
  | "profile_invalid_fields"
  | "profile_protected_fields"
  | "profile_invalid_value";

export class StudentProfileInputError extends Error {
  constructor(
    public readonly code: StudentProfileInputErrorCode,
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
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "displayName must be a string between 2 and 120 characters",
      { fields: ["displayName"] },
    );
  }

  const normalized = value.trim();

  if (normalized.length < MIN_DISPLAY_NAME_LENGTH || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "displayName must be a string between 2 and 120 characters",
      { fields: ["displayName"] },
    );
  }

  return normalized;
};

const parseOptionalHeadline = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "headline must be a string up to 160 characters",
      { fields: ["headline"] },
    );
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > MAX_HEADLINE_LENGTH) {
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "headline must be a string up to 160 characters",
      { fields: ["headline"] },
    );
  }

  return normalized;
};

const parseOptionalPhoneNumber = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "phoneNumber must be a valid phone number",
      { fields: ["phoneNumber"] },
    );
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const compact = trimmed.replace(/[\s().-]/g, "");

  if (!PHONE_PATTERN.test(compact)) {
    throw new StudentProfileInputError(
      "profile_invalid_value",
      "phoneNumber must be a valid phone number",
      { fields: ["phoneNumber"] },
    );
  }

  return compact;
};

export const parseStudentProfileUpdatePatch = (payload: unknown): StudentProfileUpdatePatch => {
  if (!isRecord(payload)) {
    throw new StudentProfileInputError(
      "profile_invalid_payload",
      "Profile update payload must be a JSON object",
    );
  }

  const payloadKeys = Object.keys(payload);

  if (payloadKeys.length === 0) {
    throw new StudentProfileInputError(
      "profile_invalid_payload",
      "At least one editable profile field is required",
    );
  }

  const protectedFields = payloadKeys.filter((key) => protectedFieldSet.has(key));

  if (protectedFields.length > 0) {
    throw new StudentProfileInputError(
      "profile_protected_fields",
      "Some fields cannot be modified through this profile endpoint",
      { fields: protectedFields },
    );
  }

  const invalidFields = payloadKeys.filter((key) => !editableFieldSet.has(key));

  if (invalidFields.length > 0) {
    throw new StudentProfileInputError(
      "profile_invalid_fields",
      "Payload contains unsupported profile fields",
      { fields: invalidFields },
    );
  }

  const patch: StudentProfileUpdatePatch = {};

  if ("displayName" in payload) {
    patch.displayName = parseDisplayName(payload.displayName);
  }

  if ("phoneNumber" in payload) {
    patch.phoneNumber = parseOptionalPhoneNumber(payload.phoneNumber);
  }

  if ("headline" in payload) {
    patch.headline = parseOptionalHeadline(payload.headline);
  }

  return patch;
};

export const toStudentProfileInputErrorResponse = (
  error: StudentProfileInputError,
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
