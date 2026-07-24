import { NextResponse } from "next/server";
import { profileSocialPlatformEnum } from "@/server/db/schema";

// Public organizer profile — validation for the owner-authored "Penyelenggara" surface.
// A save is a FULL replacement of the profile: every scalar is set (null when blank) and the
// social-link set is replaced wholesale. All fields are descriptive only — none gates any action.

export type InstitutionSocialPlatform = (typeof profileSocialPlatformEnum.enumValues)[number];
const SOCIAL_PLATFORMS: readonly string[] = profileSocialPlatformEnum.enumValues;
const socialPlatformSet = new Set<string>(SOCIAL_PLATFORMS);

const MAX_ABOUT_LENGTH = 2000;
const MAX_CONTACT_NAME_LENGTH = 160;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 40;
const MAX_URL_LENGTH = 2048;

const ALLOWED_FIELDS = [
  "about",
  "contactName",
  "contactEmail",
  "contactPhone",
  "websiteUrl",
  "socialLinks",
] as const;
const allowedFieldSet = new Set<string>(ALLOWED_FIELDS);

export type InstitutionSocialLinkInput = {
  platform: InstitutionSocialPlatform;
  url: string;
};

export type InstitutionProfileInput = {
  about: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socialLinks: InstitutionSocialLinkInput[];
};

type InstitutionProfileErrorCode =
  | "institution_profile_invalid_payload"
  | "institution_profile_invalid_fields"
  | "institution_profile_invalid_value"
  | "institution_profile_not_editable"
  | "institution_profile_storage_unavailable";

export class InstitutionProfileInputError extends Error {
  constructor(
    public readonly code: InstitutionProfileErrorCode,
    message: string,
    public readonly details?: { fields?: string[] },
    public readonly httpStatus: number = 400,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (field: string, message: string): never => {
  throw new InstitutionProfileInputError("institution_profile_invalid_value", message, {
    fields: [field],
  });
};

const parseOptionalText = (field: string, value: unknown, maxLen: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(field, `${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) return fail(field, `${field} must be ${maxLen} characters or fewer`);
  return trimmed;
};

const parseOptionalEmail = (field: string, value: unknown): string | null => {
  const text = parseOptionalText(field, value, MAX_EMAIL_LENGTH);
  if (text === null) return null;
  // Light structural check only (an at-sign with a dotted domain); delivery is never attempted.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
    return fail(field, `${field} must be a valid email`);
  return text;
};

const parseOptionalUrl = (field: string, value: unknown): string | null => {
  const text = parseOptionalText(field, value, MAX_URL_LENGTH);
  if (text === null) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    return fail(field, `${field} must be a valid http(s) URL`);
  }
  return text;
};

const parseSocialLinks = (value: unknown): InstitutionSocialLinkInput[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return fail("socialLinks", "socialLinks must be an array");

  const seen = new Set<string>();
  const links: InstitutionSocialLinkInput[] = [];

  for (const raw of value) {
    if (!isRecord(raw)) return fail("socialLinks", "each social link must be an object");
    const platform = raw.platform;
    if (typeof platform !== "string" || !socialPlatformSet.has(platform)) {
      return fail("socialLinks", `platform must be one of: ${SOCIAL_PLATFORMS.join(", ")}`);
    }
    if (seen.has(platform)) {
      return fail("socialLinks", `duplicate social link for platform "${platform}"`);
    }
    // A blank url for a platform means "no link" — skip it rather than error, so the form can
    // send an empty field per platform.
    const url = parseOptionalUrl("socialLinks", raw.url);
    if (url === null) continue;
    seen.add(platform);
    links.push({ platform: platform as InstitutionSocialPlatform, url });
  }

  return links;
};

const assertProfilePayloadShape = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_payload",
      "Institution profile payload must be a JSON object",
    );
  }
  const unknownFields = Object.keys(payload).filter((key) => !allowedFieldSet.has(key));
  if (unknownFields.length > 0) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_fields",
      "Payload contains unsupported institution profile fields",
      { fields: unknownFields },
    );
  }
  return payload;
};

export const parseInstitutionProfileInput = (payload: unknown): InstitutionProfileInput => {
  const record = assertProfilePayloadShape(payload);
  return {
    about: parseOptionalText("about", record.about, MAX_ABOUT_LENGTH),
    contactName: parseOptionalText("contactName", record.contactName, MAX_CONTACT_NAME_LENGTH),
    contactEmail: parseOptionalEmail("contactEmail", record.contactEmail),
    contactPhone: parseOptionalText("contactPhone", record.contactPhone, MAX_PHONE_LENGTH),
    websiteUrl: parseOptionalUrl("websiteUrl", record.websiteUrl),
    socialLinks: parseSocialLinks(record.socialLinks),
  };
};

export const toInstitutionProfileInputErrorResponse = (
  error: InstitutionProfileInputError,
): NextResponse =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.httpStatus },
  );
