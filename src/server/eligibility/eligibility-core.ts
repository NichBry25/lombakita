import { NextResponse } from "next/server";
import {
  studentEducationLevelEnum,
  studentEnrollmentStatusEnum,
  type StudentEducationLevel,
  type StudentEnrollmentStatus,
} from "@/server/db/schema";

// Step 4.1 — Eligibility status enum.
// Narrow MVP subset of platform-domain-contract.yaml status_enums.student_eligibility_status.
// Same divergence pattern as DEC-0020 (competition_status narrow MVP subset). Status is
// computed on demand by checkStudentEligibility — never persisted.
export const ELIGIBILITY_STATUS_VALUES = [
  "eligible",
  "ineligible_age",
  "ineligible_enrollment",
  "incomplete",
] as const;

export type EligibilityStatus = (typeof ELIGIBILITY_STATUS_VALUES)[number];

// Step 4.1 — Eligibility reason codes (typed string literals, never free-form text).
// Reasons are produced by checkStudentEligibility alongside status. Multiple reasons may
// surface in a single result (e.g. ineligible_age + missing university_name when both apply).
export const ELIGIBILITY_REASON_VALUES = [
  "missing_date_of_birth",
  "missing_enrollment_status",
  "missing_education_level",
  "missing_university_name",
  "missing_student_id_number",
  "age_below_minimum",
  "age_above_maximum",
  "enrollment_status_on_leave",
  "enrollment_status_graduated",
  "enrollment_status_unknown",
] as const;

export type EligibilityReason = (typeof ELIGIBILITY_REASON_VALUES)[number];

export type EligibilityProfileSnapshot = {
  dateOfBirth: string | null;
  enrollmentStatus: StudentEnrollmentStatus | null;
  educationLevel: StudentEducationLevel | null;
  universityName: string | null;
  studentIdNumber: string | null;
};

export type EligibilityResult = {
  status: EligibilityStatus;
  reasons: EligibilityReason[];
  checkedAt: Date;
};

// Age bounds — locked product rule (CLAUDE.md). Both bounds inclusive.
export const ELIGIBILITY_MIN_AGE = 18;
export const ELIGIBILITY_MAX_AGE = 32;

// Pure age computation. Reads year/month/day so it is DST-safe and stable across server
// timezones. `referenceDate` is injected for tests; production callers pass the current Date.
export const computeAgeYears = (dateOfBirth: Date, referenceDate: Date): number => {
  let age = referenceDate.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = referenceDate.getUTCMonth() - dateOfBirth.getUTCMonth();

  if (
    monthDelta < 0 ||
    (monthDelta === 0 && referenceDate.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age -= 1;
  }

  return age;
};

const parseDateOfBirth = (value: string): Date | null => {
  // Drizzle date column with mode: "string" returns "YYYY-MM-DD". Parse as UTC to avoid
  // local-tz drift; computeAgeYears reads UTC fields exclusively.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

// Pure eligibility evaluation. Runs every dimension independently and aggregates reasons —
// no short-circuit. Status is the highest-precedence ineligibility category present, or
// `incomplete` if any required field is missing, or `eligible` otherwise.
//
// Precedence on conflict: `incomplete` wins over named ineligibility, because the student
// cannot be definitively classified until all fields are filled. Once complete, named
// ineligibility (age or enrollment) takes priority over `eligible`.
export const evaluateEligibility = (
  snapshot: EligibilityProfileSnapshot,
  referenceDate: Date,
): EligibilityResult => {
  const reasons: EligibilityReason[] = [];
  let hasMissingField = false;

  if (!snapshot.dateOfBirth) {
    reasons.push("missing_date_of_birth");
    hasMissingField = true;
  }

  if (!snapshot.enrollmentStatus) {
    reasons.push("missing_enrollment_status");
    hasMissingField = true;
  }

  if (!snapshot.educationLevel) {
    reasons.push("missing_education_level");
    hasMissingField = true;
  }

  if (!snapshot.universityName || snapshot.universityName.trim().length === 0) {
    reasons.push("missing_university_name");
    hasMissingField = true;
  }

  if (!snapshot.studentIdNumber || snapshot.studentIdNumber.trim().length === 0) {
    reasons.push("missing_student_id_number");
    hasMissingField = true;
  }

  let ageOutOfRange = false;

  if (snapshot.dateOfBirth) {
    const dob = parseDateOfBirth(snapshot.dateOfBirth);

    if (dob) {
      const age = computeAgeYears(dob, referenceDate);

      if (age < ELIGIBILITY_MIN_AGE) {
        reasons.push("age_below_minimum");
        ageOutOfRange = true;
      } else if (age > ELIGIBILITY_MAX_AGE) {
        reasons.push("age_above_maximum");
        ageOutOfRange = true;
      }
    }
  }

  let enrollmentInvalid = false;

  if (snapshot.enrollmentStatus && snapshot.enrollmentStatus !== "enrolled") {
    if (snapshot.enrollmentStatus === "on_leave") {
      reasons.push("enrollment_status_on_leave");
    } else if (snapshot.enrollmentStatus === "graduated") {
      reasons.push("enrollment_status_graduated");
    } else if (snapshot.enrollmentStatus === "unknown") {
      reasons.push("enrollment_status_unknown");
    }
    enrollmentInvalid = true;
  }

  let status: EligibilityStatus;

  if (hasMissingField) {
    status = "incomplete";
  } else if (ageOutOfRange) {
    status = "ineligible_age";
  } else if (enrollmentInvalid) {
    status = "ineligible_enrollment";
  } else {
    status = "eligible";
  }

  return {
    status,
    reasons,
    checkedAt: referenceDate,
  };
};

// Validation primitives for the eligibility profile PATCH payload.
type EligibilityInputErrorCode =
  | "eligibility_invalid_payload"
  | "eligibility_invalid_fields"
  | "eligibility_protected_fields"
  | "eligibility_invalid_value";

export class EligibilityInputError extends Error {
  constructor(
    public readonly code: EligibilityInputErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

export type EligibilityProfileUpdatePatch = {
  dateOfBirth?: string | null;
  enrollmentStatus?: StudentEnrollmentStatus | null;
  educationLevel?: StudentEducationLevel | null;
  universityName?: string | null;
  studentIdNumber?: string | null;
};

const EDITABLE_FIELDS = [
  "dateOfBirth",
  "enrollmentStatus",
  "educationLevel",
  "universityName",
  "studentIdNumber",
] as const;

// `status` and `reasons` are NEVER client-writable — the helper computes them on every read.
// `userId` and audit timestamps are server-managed.
const PROTECTED_FIELDS = [
  "status",
  "reasons",
  "checkedAt",
  "userId",
  "createdAt",
  "updatedAt",
] as const;

const editableFieldSet = new Set<string>(EDITABLE_FIELDS);
const protectedFieldSet = new Set<string>(PROTECTED_FIELDS);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const MAX_UNIVERSITY_NAME_LENGTH = 200;
const MAX_STUDENT_ID_LENGTH = 64;

const parseDateOfBirthInput = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  // Reject future dates outright — date_of_birth in the future is never legitimate.
  if (parsed.getTime() > Date.now()) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      "dateOfBirth must be a YYYY-MM-DD string in the past",
      { fields: ["dateOfBirth"] },
    );
  }

  return trimmed;
};

const parseEnrollmentStatusInput = (value: unknown): StudentEnrollmentStatus | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `enrollmentStatus must be one of ${studentEnrollmentStatusEnum.enumValues.join(", ")}`,
      { fields: ["enrollmentStatus"] },
    );
  }

  if (!(studentEnrollmentStatusEnum.enumValues as readonly string[]).includes(value)) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `enrollmentStatus must be one of ${studentEnrollmentStatusEnum.enumValues.join(", ")}`,
      { fields: ["enrollmentStatus"] },
    );
  }

  return value as StudentEnrollmentStatus;
};

const parseEducationLevelInput = (value: unknown): StudentEducationLevel | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `educationLevel must be one of ${studentEducationLevelEnum.enumValues.join(", ")}`,
      { fields: ["educationLevel"] },
    );
  }

  if (!(studentEducationLevelEnum.enumValues as readonly string[]).includes(value)) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `educationLevel must be one of ${studentEducationLevelEnum.enumValues.join(", ")}`,
      { fields: ["educationLevel"] },
    );
  }

  return value as StudentEducationLevel;
};

const parseOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `${field} must be a string up to ${maxLength} characters`,
      { fields: [field] },
    );
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new EligibilityInputError(
      "eligibility_invalid_value",
      `${field} must be a string up to ${maxLength} characters`,
      { fields: [field] },
    );
  }

  return trimmed;
};

export const parseEligibilityProfileUpdatePatch = (
  payload: unknown,
): EligibilityProfileUpdatePatch => {
  if (!isRecord(payload)) {
    throw new EligibilityInputError(
      "eligibility_invalid_payload",
      "Eligibility update payload must be a JSON object",
    );
  }

  const payloadKeys = Object.keys(payload);

  if (payloadKeys.length === 0) {
    throw new EligibilityInputError(
      "eligibility_invalid_payload",
      "At least one editable eligibility field is required",
    );
  }

  const protectedFields = payloadKeys.filter((key) => protectedFieldSet.has(key));

  if (protectedFields.length > 0) {
    throw new EligibilityInputError(
      "eligibility_protected_fields",
      "Eligibility status and reasons are server-computed and cannot be set by the client",
      { fields: protectedFields },
    );
  }

  const invalidFields = payloadKeys.filter((key) => !editableFieldSet.has(key));

  if (invalidFields.length > 0) {
    throw new EligibilityInputError(
      "eligibility_invalid_fields",
      "Payload contains unsupported eligibility fields",
      { fields: invalidFields },
    );
  }

  const patch: EligibilityProfileUpdatePatch = {};

  if ("dateOfBirth" in payload) {
    patch.dateOfBirth = parseDateOfBirthInput(payload.dateOfBirth);
  }

  if ("enrollmentStatus" in payload) {
    patch.enrollmentStatus = parseEnrollmentStatusInput(payload.enrollmentStatus);
  }

  if ("educationLevel" in payload) {
    patch.educationLevel = parseEducationLevelInput(payload.educationLevel);
  }

  if ("universityName" in payload) {
    patch.universityName = parseOptionalText(
      payload.universityName,
      "universityName",
      MAX_UNIVERSITY_NAME_LENGTH,
    );
  }

  if ("studentIdNumber" in payload) {
    patch.studentIdNumber = parseOptionalText(
      payload.studentIdNumber,
      "studentIdNumber",
      MAX_STUDENT_ID_LENGTH,
    );
  }

  return patch;
};

export const toEligibilityInputErrorResponse = (error: EligibilityInputError): NextResponse => {
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
