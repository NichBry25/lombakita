import { SESSION_MISMATCH_CODE, SESSION_MISMATCH_MESSAGE } from "@/lib/session/session-fetch";

// What a surface says when a request was refused. The server's own message is written for a log, so a
// surface shows its own copy for the codes it expects, this shared copy for the codes any route can
// send, and its own fallback sentence for everything else.
const SHARED_ERROR_COPY: Partial<Record<string, string>> = {
  [SESSION_MISMATCH_CODE]: SESSION_MISMATCH_MESSAGE,
  unauthenticated: "Sesi Anda sudah berakhir. Masuk kembali lalu coba lagi.",
  account_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  account_state_unavailable: "Status akun Anda belum bisa diperiksa. Coba lagi beberapa saat.",
  forbidden: "Anda tidak punya akses untuk tindakan ini.",
  mfa_enrolment_required: "Aktifkan verifikasi dua langkah terlebih dahulu untuk melanjutkan.",
  mfa_challenge_required: "Selesaikan verifikasi dua langkah terlebih dahulu untuk melanjutkan.",
  rate_limited: "Terlalu banyak permintaan. Coba lagi dalam beberapa menit.",
};

export const NETWORK_ERROR_MESSAGE = "Gagal mengirim permintaan karena gangguan koneksi.";

export const errorMessageFor = (
  code: string | null | undefined,
  surfaceCopy: Partial<Record<string, string>>,
  fallback: string,
): string => {
  if (!code) return fallback;
  return surfaceCopy[code] ?? SHARED_ERROR_COPY[code] ?? fallback;
};
