import { NextResponse } from "next/server";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  INSTITUTION_MEDIA_RULES,
  type InstitutionMediaKind,
} from "@/lib/media/institution-media-rules";
import {
  InstitutionProfileInputError,
  toInstitutionProfileInputErrorResponse,
} from "@/server/institution-workspace/institution-profile-core";
import {
  deleteInstitutionMedia,
  generateInstitutionMediaUploadUrl,
  recordInstitutionMedia,
} from "@/server/institution-workspace/institution-media-service";

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_payload",
      "Request body must be a JSON object",
    );
  }
};

// Runs an owner-scoped handler behind the auth gate + cross-session guard (Rule #16).
const runOwned = async (
  request: Request,
  handler: (userId: string) => Promise<Response>,
): Promise<Response> => {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);
    return await handler(session.user.id);
  } catch (error) {
    if (error instanceof InstitutionProfileInputError) {
      return toInstitutionProfileInputErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
};

const requireAllowedMimeType = (kind: InstitutionMediaKind, value: unknown): string => {
  if (typeof value !== "string" || !INSTITUTION_MEDIA_RULES[kind].mimeTypes.includes(value)) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_value",
      "mimeType must be a supported image type",
      { fields: ["mimeType"] },
    );
  }
  return value;
};

const requireFileKey = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_value",
      "fileKey is required",
      { fields: ["fileKey"] },
    );
  }
  return value;
};

// Size is client-declared (the DEC-0066 boundary — no server-side byte inspection on this path),
// so this caps what a well-behaved client may record rather than what R2 actually holds.
const assertWithinSizeLimit = (kind: InstitutionMediaKind, value: unknown): void => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_value",
      "sizeBytes must be a positive integer",
      { fields: ["sizeBytes"] },
    );
  }
  if (value > INSTITUTION_MEDIA_RULES[kind].maxBytes) {
    throw new InstitutionProfileInputError(
      "institution_profile_invalid_value",
      "File exceeds the maximum allowed size",
      { fields: ["sizeBytes"] },
    );
  }
};

// POST — presign a direct-to-R2 PUT. Writes nothing; the key is recorded by the PUT handler once
// the browser confirms the object landed.
export const institutionMediaUploadUrl = (
  request: Request,
  institutionSlug: string,
  kind: InstitutionMediaKind,
): Promise<Response> =>
  runOwned(request, async (userId) => {
    const body = await readJson(request);
    const contentType = requireAllowedMimeType(kind, body.mimeType);
    const grant = await generateInstitutionMediaUploadUrl(userId, institutionSlug, kind, {
      contentType,
    });
    return NextResponse.json(grant, { status: 201 });
  });

export const institutionMediaRecord = (
  request: Request,
  institutionSlug: string,
  kind: InstitutionMediaKind,
): Promise<Response> =>
  runOwned(request, async (userId) => {
    const body = await readJson(request);
    const fileKey = requireFileKey(body.fileKey);
    requireAllowedMimeType(kind, body.mimeType);
    assertWithinSizeLimit(kind, body.sizeBytes);
    await recordInstitutionMedia(userId, institutionSlug, kind, fileKey);
    return NextResponse.json({ ok: true });
  });

export const institutionMediaDelete = (
  request: Request,
  institutionSlug: string,
  kind: InstitutionMediaKind,
): Promise<Response> =>
  runOwned(request, async (userId) => {
    await deleteInstitutionMedia(userId, institutionSlug, kind);
    return NextResponse.json({ ok: true });
  });
