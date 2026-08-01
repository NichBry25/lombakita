import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

// The browser half of the presign → PUT → record upload, shared by profile and institution imagery.
// The endpoints differ only in their base path, so this takes one and derives both calls from it:
//   POST <basePath>/upload-url  → { uploadUrl, fileKey }
//   PUT  <basePath>             → records the key
//   DELETE <basePath>           → removes what is stored
//
// Recording as a separate step is what makes an abandoned upload harmless: nothing points at the
// object until the bytes are confirmed to have landed.

export type UploadRules = { maxBytes: number; mimeTypes: readonly string[] };

export type UploadOutcome = { ok: true } | { ok: false; message: string };

const GENERIC_ERROR = "Terjadi kesalahan. Coba lagi.";
const TYPE_NOT_ALLOWED = "Tipe berkas tidak didukung.";
const TOO_LARGE = "Ukuran berkas melebihi batas.";

const MESSAGES: Record<string, string> = {
  profile_file_type_not_allowed: TYPE_NOT_ALLOWED,
  profile_file_too_large: TOO_LARGE,
  profile_file_unavailable: "Penyimpanan berkas belum dikonfigurasi. Coba lagi nanti.",
  institution_profile_invalid_value: "Berkas tidak valid.",
  institution_profile_not_editable: "Institusi ini tidak dapat mengunggah gambar sendiri.",
  institution_profile_storage_unavailable:
    "Penyimpanan berkas belum dikonfigurasi. Coba lagi nanti.",
  [SESSION_MISMATCH_CODE]: SESSION_MISMATCH_MESSAGE,
};

const messageFor = (data: { error?: { code?: string; message?: string } }): string => {
  const code = data.error?.code;
  const mapped = code ? MESSAGES[code] : undefined;
  return mapped ?? data.error?.message ?? GENERIC_ERROR;
};

const readJson = async (
  res: Response,
): Promise<{ error?: { code?: string; message?: string } } & Record<string, unknown>> => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

// Client-side pre-check so an oversize/wrong-type file fails fast without a wasted round-trip. The
// server re-validates regardless (this is convenience, not the security boundary).
const localValidationError = (rules: UploadRules, file: File): string | null => {
  if (!rules.mimeTypes.includes(file.type)) return TYPE_NOT_ALLOWED;
  if (file.size > rules.maxBytes) return TOO_LARGE;
  return null;
};

export async function uploadCroppedImage(
  expectedUserId: string,
  basePath: string,
  rules: UploadRules,
  file: File,
): Promise<UploadOutcome> {
  const localError = localValidationError(rules, file);
  if (localError) return { ok: false, message: localError };

  const urlRes = await sessionFetch(expectedUserId, `${basePath}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
  }).catch(() => null);
  if (!urlRes) return { ok: false, message: "Gagal terhubung ke server." };
  const urlData = await readJson(urlRes);
  if (!urlRes.ok) return { ok: false, message: messageFor(urlData) };

  const uploadUrl = urlData.uploadUrl as string | undefined;
  const fileKey = urlData.fileKey as string | undefined;
  if (!uploadUrl || !fileKey) return { ok: false, message: "Respons unggahan tidak valid." };

  // No session header here — this is a cross-origin signed request to R2.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  }).catch(() => null);
  if (!putRes || !putRes.ok) {
    return { ok: false, message: "Gagal mengunggah berkas ke penyimpanan." };
  }

  const recordRes = await sessionFetch(expectedUserId, basePath, {
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
  if (!recordRes.ok) return { ok: false, message: messageFor(await readJson(recordRes)) };

  return { ok: true };
}

export async function deleteUploadedImage(
  expectedUserId: string,
  basePath: string,
): Promise<UploadOutcome> {
  const res = await sessionFetch(expectedUserId, basePath, { method: "DELETE" }).catch(() => null);
  if (!res) return { ok: false, message: "Gagal terhubung ke server." };
  if (!res.ok) return { ok: false, message: messageFor(await readJson(res)) };
  return { ok: true };
}
