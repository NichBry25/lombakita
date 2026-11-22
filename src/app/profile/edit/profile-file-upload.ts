import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";
import { PROFILE_FILE_RULES, type ProfileFileKind } from "@/server/user-profile/profile-files-core";

export type UploadOutcome = { ok: true } | { ok: false; message: string };

const MESSAGES = {
  profile_file_type_not_allowed: "Tipe berkas tidak didukung.",
  profile_file_too_large: "Ukuran berkas melebihi batas.",
  profile_file_unavailable: "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
  profile_file_invalid_key: "Unggahan tidak cocok dengan akun ini. Unggah ulang berkas Anda.",
  profile_file_not_found: "Sertifikat ini sudah tidak ada. Muat ulang halaman.",
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
};

const PROFILE_FILE_UPLOAD_FALLBACK = "Gagal mengunggah berkas. Coba lagi.";
export const PROFILE_FILE_REMOVE_FALLBACK = "Gagal menghapus berkas. Coba lagi.";
export const RESUME_VISIBILITY_FALLBACK = "Gagal mengubah visibilitas resume. Coba lagi.";

const messageFor = (data: { error?: { code?: string } }, fallback: string): string =>
  errorMessageFor(data.error?.code, MESSAGES, fallback);

const readJson = async (
  res: Response,
): Promise<{ error?: { code?: string } } & Record<string, unknown>> => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

// Client-side pre-check so an oversize/wrong-type file fails fast without a wasted R2 round-trip.
// The server re-validates regardless (this is convenience, not the security boundary).
const localValidationError = (kind: ProfileFileKind, file: File): string | null => {
  const rules = PROFILE_FILE_RULES[kind];
  if (!rules.mimeTypes.includes(file.type)) return MESSAGES.profile_file_type_not_allowed;
  if (file.size > rules.maxBytes) return MESSAGES.profile_file_too_large;
  return null;
};

// The three-step upload: (1) request a presigned PUT URL, (2) upload the bytes straight to R2 with
// a plain fetch (NO session header — it is a cross-origin signed request), (3) record the key +
// metadata on our own API. `uploadUrlPath` and `recordPath` are relative to /api/v1/users/me/profile.
export async function uploadProfileFile(
  expectedUserId: string,
  kind: ProfileFileKind,
  paths: { uploadUrlPath: string; recordPath: string },
  file: File,
): Promise<UploadOutcome> {
  const localError = localValidationError(kind, file);
  if (localError) return { ok: false, message: localError };

  const base = "/api/v1/users/me/profile";

  const urlRes = await sessionFetch(expectedUserId, `${base}${paths.uploadUrlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
  }).catch(() => null);
  if (!urlRes) return { ok: false, message: "Gagal terhubung ke server." };
  const urlData = await readJson(urlRes);
  if (!urlRes.ok) return { ok: false, message: messageFor(urlData, PROFILE_FILE_UPLOAD_FALLBACK) };

  const uploadUrl = urlData.uploadUrl as string | undefined;
  const fileKey = urlData.fileKey as string | undefined;
  if (!uploadUrl || !fileKey) return { ok: false, message: "Respons unggahan tidak valid." };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  }).catch(() => null);
  if (!putRes || !putRes.ok) {
    return { ok: false, message: "Gagal mengunggah berkas ke penyimpanan." };
  }

  const recordRes = await sessionFetch(expectedUserId, `${base}${paths.recordPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileKey,
      fileName: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
    }),
  }).catch(() => null);
  if (!recordRes) return { ok: false, message: "Gagal terhubung ke server." };
  const recordData = await readJson(recordRes);
  if (!recordRes.ok) {
    return { ok: false, message: messageFor(recordData, PROFILE_FILE_UPLOAD_FALLBACK) };
  }

  return { ok: true };
}

// Simple owner-scoped DELETE + PATCH helpers reusing the session guard.
export async function ownerFetch(
  expectedUserId: string,
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<UploadOutcome> {
  const res = await sessionFetch(expectedUserId, `/api/v1/users/me/profile${path}`, init).catch(
    () => null,
  );
  if (!res) return { ok: false, message: "Gagal terhubung ke server." };
  if (!res.ok) return { ok: false, message: messageFor(await readJson(res), fallback) };
  return { ok: true };
}
