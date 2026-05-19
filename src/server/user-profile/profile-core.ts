import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Field scope constants
// ---------------------------------------------------------------------------

// Fields tagged "shared" are readable and writable by any verified account.
// Fields tagged "candidate" require candidateVerifiedAt IS NOT NULL.
// Fields tagged "recruiter" require recruiterVerifiedAt IS NOT NULL.
// These are compile-time constants enforced at the application layer only —
// no DB column carries scope metadata.
export const FIELD_SCOPES = {
  displayName: "shared",
  bio: "shared",
  location: "shared",
  avatarUrl: "shared",
  university: "candidate",
  major: "candidate",
  graduationYear: "candidate",
  roleTitle: "recruiter",
  organizationName: "recruiter",
  websiteUrl: "recruiter",
} as const;

export type ProfileFieldName = keyof typeof FIELD_SCOPES;
export type ProfileFieldScope = "shared" | "candidate" | "recruiter";

// ---------------------------------------------------------------------------
// Per-field scope-indicator response shape (CCR-13 / DEC-0047)
// ---------------------------------------------------------------------------

// Owner API response — every field carries a status indicator.
//   populated:   field has a non-null value
//   empty:       field is null / not set
//   scope-gated: field belongs to a role the owner has not verified on this account
export type ProfileFieldValue<T> =
  | { status: "populated"; value: T }
  | { status: "empty"; value: null }
  | { status: "scope-gated" };

export type OwnerProfileResponse = {
  username: string;
  email: string;
  role: string;
  candidateVerified: boolean;
  recruiterVerified: boolean;
  displayName: ProfileFieldValue<string>;
  bio: ProfileFieldValue<string>;
  location: ProfileFieldValue<string>;
  avatarUrl: ProfileFieldValue<string>;
  university: ProfileFieldValue<string>;
  major: ProfileFieldValue<string>;
  graduationYear: ProfileFieldValue<number>;
  roleTitle: ProfileFieldValue<string>;
  organizationName: ProfileFieldValue<string>;
  websiteUrl: ProfileFieldValue<string>;
};

// Public API response — scope-gated fields are omitted entirely.
// No ProfileFieldValue wrappers; plain values only.
export type PublicProfileResponse = {
  username: string;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;
  university?: string | null;
  major?: string | null;
  graduationYear?: number | null;
  roleTitle?: string | null;
  organizationName?: string | null;
  websiteUrl?: string | null;
};

// ---------------------------------------------------------------------------
// Scope-indicator builders
// ---------------------------------------------------------------------------

export const toFieldValue = <T>(
  value: T | null | undefined,
  scope: ProfileFieldScope,
  candidateVerified: boolean,
  recruiterVerified: boolean,
): ProfileFieldValue<T> => {
  const verified =
    scope === "shared" ||
    (scope === "candidate" && candidateVerified) ||
    (scope === "recruiter" && recruiterVerified);

  if (!verified) {
    return { status: "scope-gated" };
  }

  if (value === null || value === undefined) {
    return { status: "empty", value: null };
  }

  return { status: "populated", value };
};

// Builds the owner-scoped profile response from raw DB data.
export const buildOwnerProfileResponse = (row: {
  username: string;
  email: string;
  role: string;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  displayName: string | null;
  summary: string | null;
  location: string | null;
  avatarUrl: string | null;
  university: string | null;
  major: string | null;
  graduationYear: number | null;
  roleTitle: string | null;
  organizationName: string | null;
  websiteUrl: string | null;
}): OwnerProfileResponse => {
  const cv = row.candidateVerifiedAt !== null;
  const rv = row.recruiterVerifiedAt !== null;

  return {
    username: row.username,
    email: row.email,
    role: row.role,
    candidateVerified: cv,
    recruiterVerified: rv,
    displayName: toFieldValue(row.displayName, "shared", cv, rv),
    bio: toFieldValue(row.summary, "shared", cv, rv),
    location: toFieldValue(row.location, "shared", cv, rv),
    avatarUrl: toFieldValue(row.avatarUrl, "shared", cv, rv),
    university: toFieldValue(row.university, "candidate", cv, rv),
    major: toFieldValue(row.major, "candidate", cv, rv),
    graduationYear: toFieldValue(row.graduationYear, "candidate", cv, rv),
    roleTitle: toFieldValue(row.roleTitle, "recruiter", cv, rv),
    organizationName: toFieldValue(row.organizationName, "recruiter", cv, rv),
    websiteUrl: toFieldValue(row.websiteUrl, "recruiter", cv, rv),
  };
};

// Builds the public profile response. Scope-gated fields are omitted entirely.
export const buildPublicProfileResponse = (row: {
  username: string;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  displayName: string | null;
  summary: string | null;
  location: string | null;
  avatarUrl: string | null;
  university: string | null;
  major: string | null;
  graduationYear: number | null;
  roleTitle: string | null;
  organizationName: string | null;
  websiteUrl: string | null;
}): PublicProfileResponse => {
  const cv = row.candidateVerifiedAt !== null;
  const rv = row.recruiterVerifiedAt !== null;

  const profile: PublicProfileResponse = {
    username: row.username,
    displayName: row.displayName,
    bio: row.summary,
    location: row.location,
    avatarUrl: row.avatarUrl,
  };

  // Candidate-scoped fields: only emitted if candidate role is verified.
  if (cv) {
    profile.university = row.university;
    profile.major = row.major;
    profile.graduationYear = row.graduationYear;
  }

  // Recruiter-scoped fields: only emitted if recruiter role is verified.
  if (rv) {
    profile.roleTitle = row.roleTitle;
    profile.organizationName = row.organizationName;
    profile.websiteUrl = row.websiteUrl;
  }

  return profile;
};

// ---------------------------------------------------------------------------
// Username validation
// ---------------------------------------------------------------------------

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]*[a-z0-9]$|^[a-z0-9]{1,2}$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;

export const RESERVED_USERNAMES = new Set([
  "admin",
  "api",
  "auth",
  "profile",
  "settings",
  "help",
  "about",
  "contact",
  "legal",
  "privacy",
  "terms",
  "competition",
  "competitions",
  "institution",
  "institutions",
  "candidate",
  "recruiter",
  "student",
  "saved",
  "dashboard",
  "search",
  "explore",
  "register",
  "login",
  "logout",
  "signup",
  "signin",
  "signout",
  "me",
  "null",
  "undefined",
]);

// Validates a user-supplied username. Returns the normalized value on success.
export const parseUsername = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ProfileInputError("profile_invalid_value", "Username must be a string", {
      fields: ["username"],
    });
  }

  const normalized = value.trim().toLowerCase();

  if (RESERVED_USERNAMES.has(normalized)) {
    throw new ProfileInputError("profile_reserved_username", "This username is not available", {
      fields: ["username"],
    });
  }

  if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) {
    throw new ProfileInputError(
      "profile_invalid_value",
      `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`,
      { fields: ["username"] },
    );
  }

  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new ProfileInputError(
      "profile_invalid_value",
      "Username may only contain lowercase letters, numbers, and underscores",
      { fields: ["username"] },
    );
  }

  if (!USERNAME_PATTERN.test(normalized)) {
    throw new ProfileInputError(
      "profile_invalid_value",
      "Username must start and end with a letter or number",
      { fields: ["username"] },
    );
  }

  if (/_{2,}/.test(normalized)) {
    throw new ProfileInputError(
      "profile_invalid_value",
      "Username may not contain consecutive underscores",
      { fields: ["username"] },
    );
  }

  return normalized;
};

// ---------------------------------------------------------------------------
// PATCH input validation
// ---------------------------------------------------------------------------

const SHARED_WRITABLE_FIELDS = new Set(["displayName", "bio", "location", "avatarUrl"]);
const CANDIDATE_WRITABLE_FIELDS = new Set(["university", "major", "graduationYear"]);
const RECRUITER_WRITABLE_FIELDS = new Set(["roleTitle", "organizationName", "websiteUrl"]);
const ALL_WRITABLE_FIELDS = new Set([
  "username",
  ...SHARED_WRITABLE_FIELDS,
  ...CANDIDATE_WRITABLE_FIELDS,
  ...RECRUITER_WRITABLE_FIELDS,
]);

const PROTECTED_FIELDS = new Set([
  "id",
  "userId",
  "email",
  "emailVerified",
  "role",
  "status",
  "candidateVerifiedAt",
  "recruiterVerifiedAt",
  "candidateVerified",
  "recruiterVerified",
  "createdAt",
  "updatedAt",
  "image",
  "phoneNumber",
  "summary",
]);

const MAX_BIO_LENGTH = 300;
const MAX_TEXT_LENGTH = 120;
const MAX_URL_LENGTH = 500;
const GRAD_YEAR_MIN = 1950;
const GRAD_YEAR_MAX = 2040;

export type ProfilePatch = {
  username?: string;
  displayName?: string | null;
  bio?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
  university?: string | null;
  major?: string | null;
  graduationYear?: number | null;
  roleTitle?: string | null;
  organizationName?: string | null;
  websiteUrl?: string | null;
};

type ProfileInputErrorCode =
  | "profile_invalid_payload"
  | "profile_invalid_fields"
  | "profile_protected_fields"
  | "profile_scope_violation"
  | "profile_invalid_value"
  | "profile_reserved_username"
  | "profile_username_taken";

export class ProfileInputError extends Error {
  constructor(
    public readonly code: ProfileInputErrorCode,
    message: string,
    public readonly details?: { fields?: string[]; requiredRole?: string },
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseOptionalText = (key: string, value: unknown, maxLen: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ProfileInputError("profile_invalid_value", `${key} must be a string or null`, {
      fields: [key],
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) {
    throw new ProfileInputError(
      "profile_invalid_value",
      `${key} must be ${maxLen} characters or fewer`,
      { fields: [key] },
    );
  }
  return trimmed;
};

const parseOptionalUrl = (key: string, value: unknown): string | null => {
  const text = parseOptionalText(key, value, MAX_URL_LENGTH);
  if (text === null) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new ProfileInputError("profile_invalid_value", `${key} must be a valid URL`, {
      fields: [key],
    });
  }
  return text;
};

const parseOptionalGraduationYear = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProfileInputError(
      "profile_invalid_value",
      "graduationYear must be an integer or null",
      { fields: ["graduationYear"] },
    );
  }
  if (value < GRAD_YEAR_MIN || value > GRAD_YEAR_MAX) {
    throw new ProfileInputError(
      "profile_invalid_value",
      `graduationYear must be between ${GRAD_YEAR_MIN} and ${GRAD_YEAR_MAX}`,
      { fields: ["graduationYear"] },
    );
  }
  return value;
};

// Parses and validates a PATCH payload. Enforces scope: candidate-scoped fields require
// candidateVerified=true; recruiter-scoped fields require recruiterVerified=true.
// Throws ProfileInputError (code="profile_scope_violation") for any scope violation.
export const parseProfilePatch = (
  payload: unknown,
  candidateVerified: boolean,
  recruiterVerified: boolean,
): ProfilePatch => {
  if (!isRecord(payload)) {
    throw new ProfileInputError(
      "profile_invalid_payload",
      "Profile update payload must be a JSON object",
    );
  }

  const keys = Object.keys(payload);

  if (keys.length === 0) {
    throw new ProfileInputError(
      "profile_invalid_payload",
      "At least one profile field is required",
    );
  }

  const protectedKeys = keys.filter((k) => PROTECTED_FIELDS.has(k));
  if (protectedKeys.length > 0) {
    throw new ProfileInputError(
      "profile_protected_fields",
      "Some fields cannot be modified through the profile endpoint",
      { fields: protectedKeys },
    );
  }

  const unknownKeys = keys.filter((k) => !ALL_WRITABLE_FIELDS.has(k));
  if (unknownKeys.length > 0) {
    throw new ProfileInputError("profile_invalid_fields", "Payload contains unknown fields", {
      fields: unknownKeys,
    });
  }

  // Scope violations: candidate fields when candidate role not verified.
  if (!candidateVerified) {
    const violations = keys.filter((k) => CANDIDATE_WRITABLE_FIELDS.has(k));
    if (violations.length > 0) {
      throw new ProfileInputError(
        "profile_scope_violation",
        "Candidate profile fields require the candidate role to be verified on this account",
        { fields: violations, requiredRole: "candidate" },
      );
    }
  }

  // Scope violations: recruiter fields when recruiter role not verified.
  if (!recruiterVerified) {
    const violations = keys.filter((k) => RECRUITER_WRITABLE_FIELDS.has(k));
    if (violations.length > 0) {
      throw new ProfileInputError(
        "profile_scope_violation",
        "Recruiter profile fields require the recruiter role to be verified on this account",
        { fields: violations, requiredRole: "recruiter" },
      );
    }
  }

  const patch: ProfilePatch = {};

  if ("username" in payload) {
    patch.username = parseUsername(payload.username);
  }

  if ("displayName" in payload) {
    patch.displayName = parseOptionalText("displayName", payload.displayName, MAX_TEXT_LENGTH);
  }

  if ("bio" in payload) {
    patch.bio = parseOptionalText("bio", payload.bio, MAX_BIO_LENGTH);
  }

  if ("location" in payload) {
    patch.location = parseOptionalText("location", payload.location, MAX_TEXT_LENGTH);
  }

  if ("avatarUrl" in payload) {
    patch.avatarUrl = parseOptionalUrl("avatarUrl", payload.avatarUrl);
  }

  if ("university" in payload) {
    patch.university = parseOptionalText("university", payload.university, MAX_TEXT_LENGTH);
  }

  if ("major" in payload) {
    patch.major = parseOptionalText("major", payload.major, MAX_TEXT_LENGTH);
  }

  if ("graduationYear" in payload) {
    patch.graduationYear = parseOptionalGraduationYear(payload.graduationYear);
  }

  if ("roleTitle" in payload) {
    patch.roleTitle = parseOptionalText("roleTitle", payload.roleTitle, MAX_TEXT_LENGTH);
  }

  if ("organizationName" in payload) {
    patch.organizationName = parseOptionalText(
      "organizationName",
      payload.organizationName,
      MAX_TEXT_LENGTH,
    );
  }

  if ("websiteUrl" in payload) {
    patch.websiteUrl = parseOptionalUrl("websiteUrl", payload.websiteUrl);
  }

  return patch;
};

export const toProfileInputErrorResponse = (error: ProfileInputError): NextResponse => {
  const status = error.code === "profile_scope_violation" ? 422 : 400;
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    },
    { status },
  );
};
