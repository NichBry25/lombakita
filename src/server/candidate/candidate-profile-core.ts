import { NextResponse } from "next/server";
import { candidateOccupationEnum, type CandidateOccupation } from "@/server/db/schema";

// Candidate onboarding profile — validation primitives.
// These fields are self-declared and descriptive; they never gate access. `fullName`,
// `phoneNumber`, `occupation`, and `dateOfBirth` are all required to complete onboarding. The
// profile is one uniform shape with no conditional fields.

export const CANDIDATE_OCCUPATION_VALUES = candidateOccupationEnum.enumValues;

export type CandidateProfileInput = {
  fullName: string;
  phoneNumber: string;
  occupation: CandidateOccupation;
  dateOfBirth: string;
};

// A partial patch for the /candidate-dashboard editor. Every present key is validated; absent
// keys are left unchanged.
export type CandidateProfileUpdatePatch = {
  fullName?: string;
  phoneNumber?: string;
  occupation?: CandidateOccupation;
  dateOfBirth?: string;
};

type CandidateProfileErrorCode =
  | "candidate_profile_invalid_payload"
  | "candidate_profile_invalid_fields"
  | "candidate_profile_invalid_value";

export class CandidateProfileError extends Error {
  constructor(
    public readonly code: CandidateProfileErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

const MAX_FULL_NAME_LENGTH = 120;
const MIN_FULL_NAME_LENGTH = 2;
const MAX_PHONE_LENGTH = 20;
const MIN_PHONE_LENGTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseFullName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      `fullName must be a string between ${MIN_FULL_NAME_LENGTH} and ${MAX_FULL_NAME_LENGTH} characters`,
      { fields: ["fullName"] },
    );
  }

  const trimmed = value.trim();

  if (trimmed.length < MIN_FULL_NAME_LENGTH || trimmed.length > MAX_FULL_NAME_LENGTH) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      `fullName must be a string between ${MIN_FULL_NAME_LENGTH} and ${MAX_FULL_NAME_LENGTH} characters`,
      { fields: ["fullName"] },
    );
  }

  return trimmed;
};

// Permissive phone validation: an optional leading `+` followed by digits, spaces, or hyphens.
// Stored as the trimmed input. Indonesia-first but not locale-restricted — candidates may
// register from anywhere.
const parsePhoneNumber = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      "phoneNumber must be a valid phone number",
      { fields: ["phoneNumber"] },
    );
  }

  const trimmed = value.trim();
  const digitCount = trimmed.replace(/\D/g, "").length;

  if (
    !/^\+?[\d\s-]+$/.test(trimmed) ||
    digitCount < MIN_PHONE_LENGTH ||
    trimmed.length > MAX_PHONE_LENGTH
  ) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      "phoneNumber must be a valid phone number",
      { fields: ["phoneNumber"] },
    );
  }

  return trimmed;
};

const parseOccupation = (value: unknown): CandidateOccupation => {
  if (
    typeof value !== "string" ||
    !(CANDIDATE_OCCUPATION_VALUES as readonly string[]).includes(value)
  ) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      `occupation must be one of ${CANDIDATE_OCCUPATION_VALUES.join(", ")}`,
      { fields: ["occupation"] },
    );
  }

  return value as CandidateOccupation;
};

const parseDateOfBirth = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  return trimmed;
};

// Full onboarding payload — every required field must be present. Used at registration time.
export const parseCandidateProfileInput = (payload: unknown): CandidateProfileInput => {
  if (!isRecord(payload)) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_payload",
      "Candidate profile payload must be a JSON object",
    );
  }

  return {
    fullName: parseFullName(payload.fullName),
    phoneNumber: parsePhoneNumber(payload.phoneNumber),
    occupation: parseOccupation(payload.occupation),
    dateOfBirth: parseDateOfBirth(payload.dateOfBirth),
  };
};

const EDITABLE_FIELDS = ["fullName", "phoneNumber", "occupation", "dateOfBirth"] as const;

const editableFieldSet = new Set<string>(EDITABLE_FIELDS);

// Partial patch for the /candidate-dashboard editor. At least one editable field is required;
// unknown fields are rejected so a client cannot smuggle in server-managed columns.
export const parseCandidateProfileUpdatePatch = (payload: unknown): CandidateProfileUpdatePatch => {
  if (!isRecord(payload)) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_payload",
      "Candidate profile update payload must be a JSON object",
    );
  }

  const payloadKeys = Object.keys(payload);

  if (payloadKeys.length === 0) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_payload",
      "At least one editable candidate profile field is required",
    );
  }

  const invalidFields = payloadKeys.filter((key) => !editableFieldSet.has(key));

  if (invalidFields.length > 0) {
    throw new CandidateProfileError(
      "candidate_profile_invalid_fields",
      "Payload contains unsupported candidate profile fields",
      { fields: invalidFields },
    );
  }

  const patch: CandidateProfileUpdatePatch = {};

  if ("fullName" in payload) patch.fullName = parseFullName(payload.fullName);
  if ("phoneNumber" in payload) patch.phoneNumber = parsePhoneNumber(payload.phoneNumber);
  if ("occupation" in payload) patch.occupation = parseOccupation(payload.occupation);
  if ("dateOfBirth" in payload) patch.dateOfBirth = parseDateOfBirth(payload.dateOfBirth);

  return patch;
};

export const toCandidateProfileErrorResponse = (error: CandidateProfileError): NextResponse => {
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
