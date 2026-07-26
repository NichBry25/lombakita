import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import {
  ProfileFileError,
  parseFileMetadata,
  parseUploadRequest,
  profileFileErrorStatus,
} from "@/server/user-profile/profile-files-core";
import {
  deleteAvatar,
  deleteCertificationFile,
  deleteResume,
  generateAvatarUploadUrl,
  generateCertificationFileUploadUrl,
  generateResumeUploadUrl,
  recordAvatar,
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
    return mapError(error);
  }
};

const grantResponse = (grant: UploadUrlGrant): NextResponse => NextResponse.json(grant);
const ok = (): NextResponse => NextResponse.json({ ok: true });

// ── Avatar ────────────────────────────────────────────────────────────────

export const avatarUploadUrl = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
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

// ── Resume ──────────────────────────────────────────────────────────────────

export const resumeUploadUrl = (request: Request): Promise<Response> =>
  runOwned(request, async (userId) => {
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
  runOwned(request, async (userId) => {
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
