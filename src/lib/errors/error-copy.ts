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

// Shown wherever a Google sign-up is refused because Google has not verified the address.
export const GOOGLE_EMAIL_UNVERIFIED_MESSAGE =
  "Google belum memverifikasi email ini, sehingga akun tidak dapat dibuat dengan Google. Daftar dengan email dan password, lalu masukkan kode verifikasi yang kami kirim ke email Anda.";

// Both the competition page's note to its institution's owner and staff, and the refusal they get
// when they try to take a place in the competition.
export const COMPETITION_HOST_CANNOT_JOIN_MESSAGE =
  "Anda pemilik atau staf penyelenggara kompetisi ini, jadi tidak dapat ikut mendaftar.";

// The refusal of a new registration, a new team or a team join on a competition whose institution is
// suspended, by staff or by an account deletion that anonymised it. The server sends it and each
// registration surface maps the code to it.
export const INSTITUTION_SUSPENDED_REGISTRATION_MESSAGE =
  "Penyelenggara kompetisi ini sedang dinonaktifkan, jadi pendaftaran baru belum dapat diterima.";

// One refusal code, two sentences: the owner promoting someone and the invitee accepting are told
// the same fact from their own side, so each surface maps the code to its own sentence.
export const MEMBER_HOLDS_PLACE_MESSAGE =
  "Anggota ini masih terdaftar di kompetisi lembaga ini yang belum selesai, jadi belum dapat dijadikan pemilik atau staf.";

export const INVITEE_HOLDS_PLACE_MESSAGE =
  "Anda masih terdaftar di kompetisi lembaga ini yang belum selesai, jadi belum dapat menerima undangan sebagai pemilik atau staf.";

export const OWN_PROOF_VERDICT_MESSAGE =
  "Anda tidak dapat memeriksa bukti transfer untuk pendaftaran Anda sendiri. Minta pemilik atau staf lain untuk memeriksanya.";

export const OWN_RESULT_MESSAGE =
  "Anda tidak dapat mengubah atau menerbitkan hasil untuk pendaftaran Anda sendiri. Minta pemilik atau staf lain untuk melakukannya.";

export const ENTRANT_RESULT_MESSAGE =
  "Anda terdaftar di kompetisi ini, jadi tidak dapat mengubah atau menerbitkan hasil peserta lain. Minta pemilik atau staf lain untuk melakukannya.";

export const COMPETITIONS_CHANGING_RETRY_MESSAGE =
  "Sedang ada perubahan lain pada kompetisi lembaga ini. Coba lagi.";

// A key "<code>.<field>" holds the sentence for a refusal about one field.
export const ONBOARDING_FIELD_REFUSAL_COPY: Partial<Record<string, string>> = {
  "candidate_profile_invalid_value.fullName": "Isi nama lengkap (minimal 2 karakter).",
  "candidate_profile_invalid_value.phoneNumber": "Isi nomor telepon yang valid (minimal 8 digit).",
  "candidate_profile_invalid_value.occupation": "Pilih status Anda saat ini.",
  "candidate_profile_invalid_value.dateOfBirth": "Isi tanggal lahir Anda.",
};

export const errorMessageFor = (
  code: string | null | undefined,
  surfaceCopy: Partial<Record<string, string>>,
  fallback: string,
): string => {
  if (!code) return fallback;
  return surfaceCopy[code] ?? SHARED_ERROR_COPY[code] ?? fallback;
};

export const refusalCopyKey = (
  code: string | undefined,
  field: string | undefined,
  surfaceCopy: Partial<Record<string, string>>,
): string | undefined => {
  const fieldKey = `${code}.${field}`;
  return field && surfaceCopy[fieldKey] ? fieldKey : code;
};
