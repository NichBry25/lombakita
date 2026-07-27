import { NextResponse } from "next/server";
import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";

// Recruiter trust verification — validation primitives.
// A recruiter submits a lightweight affiliation form (full name, mobile number, optional
// corporate email). The form never grants trust by itself: platform ops review the submission
// and approval elevates the account's recruiter tier. Corporate email ownership is NOT proven
// at MVP — the value informs the queue-priority domain flag and manual admin cross-checking.

export type RecruiterVerificationInput = {
  fullName: string;
  mobileNumber: string;
  corporateEmail: string | null;
};

type RecruiterVerificationErrorCode =
  | "recruiter_verification_invalid_payload"
  | "recruiter_verification_invalid_value"
  | "recruiter_verification_already_pending"
  | "recruiter_already_trusted"
  | "recruiter_verification_not_found"
  | "recruiter_verification_already_reviewed"
  | "recruiter_verification_resubmission_blocked"
  | "recruiter_verification_storage_unavailable"
  | "recruiter_verification_document_type_not_allowed"
  | "recruiter_verification_document_too_large"
  | "recruiter_verification_document_invalid"
  | "recruiter_verification_document_not_found";

const STATUS_BY_CODE: Record<RecruiterVerificationErrorCode, 400 | 404 | 409 | 422 | 503> = {
  recruiter_verification_invalid_payload: 400,
  recruiter_verification_invalid_value: 400,
  recruiter_verification_already_pending: 409,
  recruiter_already_trusted: 409,
  recruiter_verification_not_found: 404,
  recruiter_verification_already_reviewed: 409,
  recruiter_verification_resubmission_blocked: 409,
  recruiter_verification_storage_unavailable: 503,
  recruiter_verification_document_type_not_allowed: 422,
  recruiter_verification_document_too_large: 422,
  recruiter_verification_document_invalid: 422,
  recruiter_verification_document_not_found: 404,
};

export class RecruiterVerificationError extends Error {
  public readonly status: 400 | 404 | 409 | 422 | 503;

  constructor(
    public readonly code: RecruiterVerificationErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
    this.status = STATUS_BY_CODE[code];
  }
}

export const toRecruiterVerificationErrorResponse = (
  error: RecruiterVerificationError,
): NextResponse => {
  return NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status },
  );
};

const MAX_FULL_NAME_LENGTH = 120;
const MIN_FULL_NAME_LENGTH = 2;
const MAX_MOBILE_LENGTH = 20;
const MIN_MOBILE_DIGITS = 8;
const MAX_EMAIL_LENGTH = 254;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseFullName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      `fullName must be a string between ${MIN_FULL_NAME_LENGTH} and ${MAX_FULL_NAME_LENGTH} characters`,
      { fields: ["fullName"] },
    );
  }

  const trimmed = value.trim();

  if (trimmed.length < MIN_FULL_NAME_LENGTH || trimmed.length > MAX_FULL_NAME_LENGTH) {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      `fullName must be a string between ${MIN_FULL_NAME_LENGTH} and ${MAX_FULL_NAME_LENGTH} characters`,
      { fields: ["fullName"] },
    );
  }

  return trimmed;
};

// Permissive mobile validation: an optional leading `+` followed by digits, spaces, or hyphens.
// Stored as the trimmed input. Mirrors the candidate onboarding phone rule.
const parseMobileNumber = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      "mobileNumber must be a valid phone number",
      { fields: ["mobileNumber"] },
    );
  }

  const trimmed = value.trim();
  const digitCount = trimmed.replace(/\D/g, "").length;

  if (
    !/^\+?[\d\s-]+$/.test(trimmed) ||
    digitCount < MIN_MOBILE_DIGITS ||
    trimmed.length > MAX_MOBILE_LENGTH
  ) {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      "mobileNumber must be a valid phone number",
      { fields: ["mobileNumber"] },
    );
  }

  return trimmed;
};

// Optional field: absent, null, or empty/whitespace-only all normalize to null. A present value
// must look like an email address; it is stored lowercased.
const parseCorporateEmail = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;

  if (typeof value !== "string") {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      "corporateEmail must be a valid email address",
      { fields: ["corporateEmail"] },
    );
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_value",
      "corporateEmail must be a valid email address",
      { fields: ["corporateEmail"] },
    );
  }

  return trimmed;
};

export const parseRecruiterVerificationInput = (payload: unknown): RecruiterVerificationInput => {
  if (!isRecord(payload)) {
    throw new RecruiterVerificationError(
      "recruiter_verification_invalid_payload",
      "Recruiter verification payload must be an object",
    );
  }

  return {
    fullName: parseFullName(payload.fullName),
    mobileNumber: parseMobileNumber(payload.mobileNumber),
    corporateEmail: parseCorporateEmail(payload.corporateEmail),
  };
};

// Queue-priority signal: true = the declared corporate email uses a non-personal-provider
// domain, false = known personal provider, null = no corporate email declared. Advisory only —
// never a grant condition.
export const deriveCorporateEmailDomainFlag = (corporateEmail: string | null): boolean | null => {
  if (!corporateEmail) return null;
  const domain = corporateEmail.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
};
