import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { assertUploadUrlAllowed } from "@/server/storage/upload-rate-limit";
import {
  ProfileFileError,
  parseFileMetadata,
  parseUploadRequest,
  profileFileErrorStatus,
} from "@/server/user-profile/profile-files-core";
import {
  deleteAvatar,
  deleteBanner,
  deleteCertificationFile,
  deleteResume,
  generateAvatarUploadUrl,
  generateBannerUploadUrl,
  generateCertificationFileUploadUrl,
  generateResumeUploadUrl,
  recordAvatar,
  recordBanner,
  recordCertificationFile,
  recordResume,
  setResumeVisibility,
  type UploadUrlGrant,
} from "@/server/user-profile/profile-files-service";

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new ProfileFileError("profile_file_invalid_payload", "Request body must be valid JSON");
  }
};

const mapError = (error: unknown): NextResponse => {
  if (error instanceof ProfileFileError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: profileFileErrorStatus(error.code) },
    );
  }
  return toAccessDeniedResponse(error);
};

type OwnedHandler = (userId: string) => Promise<Response>;

// Runs an owner-scoped handler behind the auth gate + cross-session guard (Rule #16). Does NOT draw
// the upload-URL budget: recording an uploaded key, deleting a file and flipping resume visibility
// mint no presigned URL, so they must not consume an allowance whose purpose is to bound minting.
const runOwned = async (request: Request, handler: OwnedHandler): Promise<Response> => {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    return await handler(session.user.id);
  } catch (error) {
    return mapError(error);
  }
};

// The same, for the handlers that DO mint a presigned PUT URL. MANUAL-D57: this is the only caller of
// the limiter in this file, so a record or delete handler cannot reach the budget by accident, and
// the id it charges is the one `runOwned` resolved from the session and handed to the handler.
const runOwnedUploadUrl = (request: Request, handler: OwnedHandler): Promise<Response> =>
  runOwned(request, async (userId) => {
    const limited = await assertUploadUrlAllowed(userId);
    if (limited) return limited;

    return handler(userId);
  });

const grantResponse = (grant: UploadUrlGrant): NextResponse => NextResponse.json(grant);
const ok = (): NextResponse => NextResponse.json({ ok: true });

// ── Avatar ────────────────────────────────────────────────────────────────

export const avatarUploadUrl = (request: Request): Promise<Response> =>
  runOwnedUploadUrl(request, async (userId) => {
    const req = parseUploadRequest("avatar", await readJson(request));
    return grantResponse(await generateAvatarUploadUrl(userId, req));
  });

export const avatarRecord = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    const metadata = parseFileMetadata("avatar", await readJson(request));
    await recordAvatar(userId, metadata);
    return ok();
  });

export const avatarDelete = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    await deleteAvatar(userId);
    return ok();
  });

// ── Banner ────────────────────────────────────────────────────────────────

export const bannerUploadUrl = (request: Request): Promise<Response> =>
  runOwnedUploadUrl(request, async (userId) => {
    const req = parseUploadRequest("banner", await readJson(request));
    return grantResponse(await generateBannerUploadUrl(userId, req));
  });

export const bannerRecord = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    const metadata = parseFileMetadata("banner", await readJson(request));
    await recordBanner(userId, metadata);
    return ok();
  });

export const bannerDelete = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    await deleteBanner(userId);
    return ok();
  });

// ── Resume ──────────────────────────────────────────────────────────────────

export const resumeUploadUrl = (request: Request): Promise<Response> =>
  runOwnedUploadUrl(request, async (userId) => {
    const req = parseUploadRequest("resume", await readJson(request));
    return grantResponse(await generateResumeUploadUrl(userId, req));
  });

export const resumeRecord = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    const metadata = parseFileMetadata("resume", await readJson(request));
    await recordResume(userId, metadata);
    return ok();
  });

export const resumeDelete = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    await deleteResume(userId);
    return ok();
  });

export const resumeSetVisibility = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
    const payload = await readJson(request);
    const isPublic =
      typeof payload === "object" && payload !== null
        ? (payload as { isPublic?: unknown }).isPublic
        : undefined;
    if (typeof isPublic !== "boolean") {
      throw new ProfileFileError("profile_file_invalid_payload", "isPublic must be a boolean");
    }
    await setResumeVisibility(userId, isPublic);
    return ok();
  });

// ── Certificate file ──────────────────────────────────────────────────────────

export const certificationFileUploadUrl = (request: Request, certId: string): Promise<Response> =>
  runOwnedUploadUrl(request, async (userId) => {
    const req = parseUploadRequest("certification", await readJson(request));
    return grantResponse(await generateCertificationFileUploadUrl(userId, certId, req));
  });

export const certificationFileRecord = (request: Request, certId: string): Promise<Response> =>
  runOwned(request, async (userId) => {
    const metadata = parseFileMetadata("certification", await readJson(request));
    await recordCertificationFile(userId, certId, metadata);
    return ok();
  });

export const certificationFileDelete = (request: Request, certId: string): Promise<Response> =>
  runOwned(request, async (userId) => {
    await deleteCertificationFile(userId, certId);
    return ok();
  });
