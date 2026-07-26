// Types, validation, and error handling for the role-agnostic profile detail collections
// (experience, education, skills, certifications, social links). These replace the retired
// single scalar profile fields. No per-role scope gating applies here — any signed-in account
// may populate any collection.
//
// This module is intentionally free of any `next/server` import so it is safe to import from
// client components (for the shared entry types and the SOCIAL_PLATFORMS constant). The HTTP
// error-response mapping lives in profile-collection-http.ts (server-only).

// ---------------------------------------------------------------------------
// Client-facing entry shapes (identical for owner and public responses)
// ---------------------------------------------------------------------------

export type ExperienceEntry = {
  id: string;
  title: string;
  organizationName: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  description: string | null;
};

export type EducationEntry = {
  id: string;
  school: string;
  degree: string | null;
  fieldOfStudy: string | null;
  startYear: number | null;
  endYear: number | null;
  description: string | null;
};

export type SkillEntry = {
  id: string;
  name: string;
};

export type CertificationEntry = {
  id: string;
  name: string;
  issuer: string;
  issueDate: string | null;
  expiryDate: string | null;
  credentialId: string | null;
  credentialUrl: string | null;
  // Optional uploaded certificate file. `fileName` is set whenever a file is attached; `fileUrl`
  // is a short-lived presigned GET URL populated only on full profile reads (null on mutation
  // responses and when R2 is unavailable).
  fileName: string | null;
  fileUrl: string | null;
};

// Owner-facing resume descriptor (always returned to the owner when a resume exists).
export type OwnerResume = {
  fileName: string;
  sizeBytes: number | null;
  mimeType: string | null;
  isPublic: boolean;
  downloadUrl: string | null;
};

// Public-facing resume descriptor (returned on the public profile only when resume_public is on).
export type PublicResume = {
  fileName: string;
  downloadUrl: string | null;
};

export const SOCIAL_PLATFORMS = ["linkedin", "github", "instagram", "x", "website"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialLinkEntry = {
  id: string;
  platform: SocialPlatform;
  url: string;
};

export type ProfileCollections = {
  experiences: ExperienceEntry[];
  educations: EducationEntry[];
  skills: SkillEntry[];
  certifications: CertificationEntry[];
  socialLinks: SocialLinkEntry[];
};

export const emptyProfileCollections = (): ProfileCollections => ({
  experiences: [],
  educations: [],
  skills: [],
  certifications: [],
  socialLinks: [],
});

// ---------------------------------------------------------------------------
// Validated input shapes (what the service layer writes)
// ---------------------------------------------------------------------------

export type ExperienceInput = {
  title: string;
  organizationName: string;
  location: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
  description: string | null;
};

export type EducationInput = {
  school: string;
  degree: string | null;
  fieldOfStudy: string | null;
  startYear: number | null;
  endYear: number | null;
  description: string | null;
};

export type SkillInput = {
  name: string;
};

export type CertificationInput = {
  name: string;
  issuer: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  credentialId: string | null;
  credentialUrl: string | null;
};

export type SocialLinkInput = {
  platform: SocialPlatform;
  url: string;
};

// ---------------------------------------------------------------------------
// Limits and field bounds
// ---------------------------------------------------------------------------

export const MAX_ENTRIES_PER_COLLECTION = 50;

const MAX_SHORT_TEXT = 120;
const MAX_ORG_TEXT = 160;
const MAX_DESCRIPTION = 1000;
const MAX_SKILL_NAME = 60;
const MAX_URL_LENGTH = 500;
const YEAR_MIN = 1950;
const YEAR_MAX = 2040;

// ---------------------------------------------------------------------------
// Error type + response mapping
// ---------------------------------------------------------------------------

export type ProfileCollectionErrorCode =
  | "profile_collection_invalid_payload"
  | "profile_collection_invalid_value"
  | "profile_collection_not_found"
  | "profile_collection_duplicate"
  | "profile_collection_limit_reached";

export class ProfileCollectionError extends Error {
  constructor(
    public readonly code: ProfileCollectionErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
  ) {
    super(message);
  }
}

// Maps an error code to its HTTP status. The NextResponse construction lives in the server-only
// HTTP helper so this module stays client-importable.
export const profileCollectionErrorStatus = (code: ProfileCollectionErrorCode): number => {
  if (code === "profile_collection_not_found") return 404;
  if (code === "profile_collection_duplicate" || code === "profile_collection_limit_reached") {
    return 409;
  }
  return 400;
};

// ---------------------------------------------------------------------------
// Shared field parsers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (field: string, message: string): never => {
  throw new ProfileCollectionError("profile_collection_invalid_value", message, {
    fields: [field],
  });
};

const parseRequiredText = (field: string, value: unknown, maxLen: number): string => {
  if (typeof value !== "string") return fail(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(field, `${field} is required`);
  if (trimmed.length > maxLen) return fail(field, `${field} must be ${maxLen} characters or fewer`);
  return trimmed;
};

const parseOptionalText = (field: string, value: unknown, maxLen: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(field, `${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) return fail(field, `${field} must be ${maxLen} characters or fewer`);
  return trimmed;
};

const parseOptionalUrl = (field: string, value: unknown): string | null => {
  const text = parseOptionalText(field, value, MAX_URL_LENGTH);
  if (text === null) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    return fail(field, `${field} must be a valid URL`);
  }
  return text;
};

const parseRequiredUrl = (field: string, value: unknown): string => {
  const url = parseOptionalUrl(field, value);
  if (url === null) return fail(field, `${field} is required`);
  return url;
};

// Accepts a "YYYY-MM-DD" calendar string (or null); returns a UTC-midnight Date.
const parseOptionalDate = (field: string, value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail(field, `${field} must be a YYYY-MM-DD date or null`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return fail(field, `${field} is not a valid date`);
  return date;
};

const parseOptionalYear = (field: string, value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(field, `${field} must be an integer year or null`);
  }
  if (value < YEAR_MIN || value > YEAR_MAX) {
    return fail(field, `${field} must be between ${YEAR_MIN} and ${YEAR_MAX}`);
  }
  return value;
};

const parseBool = (field: string, value: unknown): boolean => {
  if (typeof value !== "boolean") return fail(field, `${field} must be a boolean`);
  return value;
};

// ---------------------------------------------------------------------------
// Per-collection parsers
// ---------------------------------------------------------------------------

export const parseExperienceInput = (payload: unknown): ExperienceInput => {
  if (!isRecord(payload)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Experience payload must be a JSON object",
    );
  }
  const startDate = parseOptionalDate("startDate", payload.startDate);
  const isCurrent =
    payload.isCurrent === undefined ? false : parseBool("isCurrent", payload.isCurrent);
  const endDate = isCurrent ? null : parseOptionalDate("endDate", payload.endDate);
  if (startDate && endDate && endDate < startDate) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_value",
      "endDate must be on or after startDate",
      { fields: ["endDate"] },
    );
  }
  return {
    title: parseRequiredText("title", payload.title, MAX_SHORT_TEXT),
    organizationName: parseRequiredText("organizationName", payload.organizationName, MAX_ORG_TEXT),
    location: parseOptionalText("location", payload.location, MAX_SHORT_TEXT),
    startDate,
    endDate,
    isCurrent,
    description: parseOptionalText("description", payload.description, MAX_DESCRIPTION),
  };
};

export const parseEducationInput = (payload: unknown): EducationInput => {
  if (!isRecord(payload)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Education payload must be a JSON object",
    );
  }
  const startYear = parseOptionalYear("startYear", payload.startYear);
  const endYear = parseOptionalYear("endYear", payload.endYear);
  if (startYear !== null && endYear !== null && endYear < startYear) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_value",
      "endYear must be on or after startYear",
      { fields: ["endYear"] },
    );
  }
  return {
    school: parseRequiredText("school", payload.school, MAX_SHORT_TEXT),
    degree: parseOptionalText("degree", payload.degree, MAX_SHORT_TEXT),
    fieldOfStudy: parseOptionalText("fieldOfStudy", payload.fieldOfStudy, MAX_SHORT_TEXT),
    startYear,
    endYear,
    description: parseOptionalText("description", payload.description, MAX_DESCRIPTION),
  };
};

export const parseSkillInput = (payload: unknown): SkillInput => {
  if (!isRecord(payload)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Skill payload must be a JSON object",
    );
  }
  return { name: parseRequiredText("name", payload.name, MAX_SKILL_NAME) };
};

export const parseCertificationInput = (payload: unknown): CertificationInput => {
  if (!isRecord(payload)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Certification payload must be a JSON object",
    );
  }
  const issueDate = parseOptionalDate("issueDate", payload.issueDate);
  const expiryDate = parseOptionalDate("expiryDate", payload.expiryDate);
  if (issueDate && expiryDate && expiryDate < issueDate) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_value",
      "expiryDate must be on or after issueDate",
      { fields: ["expiryDate"] },
    );
  }
  return {
    name: parseRequiredText("name", payload.name, MAX_SHORT_TEXT),
    issuer: parseRequiredText("issuer", payload.issuer, MAX_SHORT_TEXT),
    issueDate,
    expiryDate,
    credentialId: parseOptionalText("credentialId", payload.credentialId, MAX_SHORT_TEXT),
    credentialUrl: parseOptionalUrl("credentialUrl", payload.credentialUrl),
  };
};

const isSocialPlatform = (v: unknown): v is SocialPlatform =>
  typeof v === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(v);

export const parseSocialLinkInput = (payload: unknown): SocialLinkInput => {
  if (!isRecord(payload)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_payload",
      "Social link payload must be a JSON object",
    );
  }
  if (!isSocialPlatform(payload.platform)) {
    throw new ProfileCollectionError(
      "profile_collection_invalid_value",
      `platform must be one of: ${SOCIAL_PLATFORMS.join(", ")}`,
      { fields: ["platform"] },
    );
  }
  return {
    platform: payload.platform,
    url: parseRequiredUrl("url", payload.url),
  };
};

// Serializes a stored Date (date column) to a "YYYY-MM-DD" string for client responses.
export const toDateString = (date: Date | null): string | null => {
  if (date === null) return null;
  return date.toISOString().slice(0, 10);
};

// Derives the identity-header meta line from the collections (the retired scalar affiliation and
// website fields used to supply these). Affiliation prefers the current role, then the most recent
// experience, then the top education; website comes from the "website" social link if present.
export const deriveProfileHeader = (
  collections: ProfileCollections,
): { affiliation: string | null; websiteUrl: string | null } => {
  const current =
    collections.experiences.find((entry) => entry.isCurrent) ?? collections.experiences[0];
  const affiliation = current?.organizationName ?? collections.educations[0]?.school ?? null;
  const websiteUrl =
    collections.socialLinks.find((link) => link.platform === "website")?.url ?? null;
  return { affiliation, websiteUrl };
};
