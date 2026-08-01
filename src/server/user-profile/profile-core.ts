import { NextResponse } from "next/server";
import { RESERVED_WORDS } from "@/lib/username/reserved-words";
import {
  emptyProfileCollections,
  type OwnerResume,
  type ProfileCollections,
  type PublicResume,
} from "@/server/user-profile/profile-collections-core";

// ---------------------------------------------------------------------------
// Field scope constants
// ---------------------------------------------------------------------------

// The remaining scalar profile fields are all "shared": readable and writable by any account, no
// per-role gating. The former candidate-scoped and recruiter-scoped scalar fields were retired
// (their data now lives in the role-agnostic profile collections). The "candidate"/"recruiter"
// scope values are retained in the type for forward compatibility but currently unused.
export const FIELD_SCOPES = {
  displayName: "shared",
  bio: "shared",
  location: "shared",
  avatarUrl: "shared",
  bannerUrl: "shared",
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
  // True when the recruiter account is a Trusted Recruiter (tier `elevated`) — the public
  // publish-authority signal. Derived, never the raw tier value.
  trustedRecruiter: boolean;
  displayName: ProfileFieldValue<string>;
  bio: ProfileFieldValue<string>;
  location: ProfileFieldValue<string>;
  avatarUrl: ProfileFieldValue<string>;
  bannerUrl: ProfileFieldValue<string>;
  resume: OwnerResume | null;
  collections: ProfileCollections;
};

// Public API response — plain scalar values plus the same role-agnostic collections the owner
// sees (the detail collections are not scope-gated). Verification booleans are exposed as a public
// trust signal (which roles this account has verified), not as a data-scoping mechanism.
export type PublicProfileResponse = {
  username: string;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  candidateVerified: boolean;
  recruiterVerified: boolean;
  trustedRecruiter: boolean;
  resume: PublicResume | null;
  collections: ProfileCollections;
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

// Builds the owner-scoped profile response from raw DB data plus the user's detail collections.
export const buildOwnerProfileResponse = (
  row: {
    username: string;
    email: string;
    role: string;
    candidateVerifiedAt: Date | null;
    recruiterVerifiedAt: Date | null;
    recruiterVerificationTier: "unverified" | "minimal" | "elevated";
    displayName: string | null;
    summary: string | null;
    location: string | null;
    avatarUrl: string | null;
  },
  collections: ProfileCollections = emptyProfileCollections(),
): OwnerProfileResponse => {
  const cv = row.candidateVerifiedAt !== null;
  const rv = row.recruiterVerifiedAt !== null;

  return {
    username: row.username,
    email: row.email,
    role: row.role,
    candidateVerified: cv,
    recruiterVerified: rv,
    trustedRecruiter: row.recruiterVerificationTier === "elevated",
    displayName: toFieldValue(row.displayName, "shared", cv, rv),
    bio: toFieldValue(row.summary, "shared", cv, rv),
    location: toFieldValue(row.location, "shared", cv, rv),
    avatarUrl: toFieldValue(row.avatarUrl, "shared", cv, rv),
    // Banner and resume are enriched by the service layer (both need an async presigned URL, and
    // the banner has no legacy plain-URL column to fall back on); empty by default.
    bannerUrl: { status: "empty", value: null },
    resume: null,
    collections,
  };
};

// Builds the public profile response from raw DB data plus the user's detail collections.
export const buildPublicProfileResponse = (
  row: {
    username: string;
    candidateVerifiedAt: Date | null;
    recruiterVerifiedAt: Date | null;
    recruiterVerificationTier: "unverified" | "minimal" | "elevated";
    displayName: string | null;
    summary: string | null;
    location: string | null;
    avatarUrl: string | null;
  },
  collections: ProfileCollections = emptyProfileCollections(),
): PublicProfileResponse => {
  return {
    username: row.username,
    displayName: row.displayName,
    bio: row.summary,
    location: row.location,
    avatarUrl: row.avatarUrl,
    // Banner is enriched by the service layer (needs an async presigned URL); null by default.
    bannerUrl: null,
    candidateVerified: row.candidateVerifiedAt !== null,
    recruiterVerified: row.recruiterVerifiedAt !== null,
    trustedRecruiter: row.recruiterVerificationTier === "elevated",
    // Resume is enriched by the service layer (only when resume_public); null by default.
    resume: null,
    collections,
  };
};

// ---------------------------------------------------------------------------
// Username validation
// ---------------------------------------------------------------------------

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]*[a-z0-9]$|^[a-z0-9]{1,2}$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;

// Step 2.1a / DEC-0054 — the reserved-word namespace now has a single source of
// truth in src/lib/username/reserved-words.ts. Built into a Set here for O(1)
// membership checks; matching is case-insensitive (input is lowercased first).
export const RESERVED_USERNAMES = new Set(RESERVED_WORDS.map((word) => word.toLowerCase()));

// Validates a user-supplied username. Returns the normalized value on success.
export const parseUsername = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ProfileInputError("profile_invalid_value", "Username must be a string", {
      fields: ["username"],
    });
  }

  const normalized = value.trim().toLowerCase();

  // Step 2.1a / DEC-0054 — reserved-word check runs before the length/charset
  // checks (and, at the route layer, before the DB uniqueness check): it is the
  // cheapest gate, so fail fast. Rejected with 422 profile_username_reserved.
  if (RESERVED_USERNAMES.has(normalized)) {
    throw new ProfileInputError(
      "profile_username_reserved",
      "This username is reserved and cannot be used",
      { fields: ["username"] },
    );
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

// avatarUrl and bannerUrl are intentionally NOT writable here — both images are managed by the
// file-upload endpoints (upload → record key), not by this scalar PATCH.
const SHARED_WRITABLE_FIELDS = new Set(["displayName", "bio", "location"]);
const ALL_WRITABLE_FIELDS = new Set(["username", ...SHARED_WRITABLE_FIELDS]);

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

export type ProfilePatch = {
  username?: string;
  displayName?: string | null;
  bio?: string | null;
  location?: string | null;
};

type ProfileInputErrorCode =
  | "profile_invalid_payload"
  | "profile_invalid_fields"
  | "profile_protected_fields"
  | "profile_scope_violation"
  | "profile_invalid_value"
  | "profile_username_reserved"
  | "profile_username_taken"
  | "profile_username_conflicts_with_institution";

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

// Parses and validates a PATCH payload for the scalar profile fields. All remaining writable
// fields are shared (no per-role scope gating), so this no longer needs verification state.
export const parseProfilePatch = (payload: unknown): ProfilePatch => {
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

  return patch;
};

export const toProfileInputErrorResponse = (error: ProfileInputError): NextResponse => {
  // 422 — scope violation and reserved-word rejection (semantic input rejections,
  //       Step 2.1a / DEC-0054).
  // 409 — username uniqueness conflict (against another account or an institution slug).
  // 400 — all other malformed-payload errors.
  const status =
    error.code === "profile_scope_violation" || error.code === "profile_username_reserved"
      ? 422
      : error.code === "profile_username_taken" ||
          error.code === "profile_username_conflicts_with_institution"
        ? 409
        : 400;
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
