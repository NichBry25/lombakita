// Indonesian copy for the refusals an operator sees when deciding an institution's verification.
//
// The server's own messages are English and are written for a log. This is the translation, kept
// in one client-safe module because two surfaces show the same refusal: the verification queue and
// the institution list. The server module that raises it is not imported here, since it pulls in
// the database client and this file is bundled into the browser.

import { errorMessageFor } from "@/lib/errors/error-copy";

export const VERIFICATION_REFUSAL_COPY: Record<string, string> = {
  // DEC-0220.
  operator_actor_conflicted:
    "Anda tidak dapat memutuskan verifikasi institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
  invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  verification_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  verification_reason_required: "Alasan wajib diisi.",
  verification_not_found: "Institusi tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  institution_not_found: "Institusi tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  institution_verification_not_applicable:
    "Institusi personal tidak memiliki verifikasi dokumen untuk ditinjau.",
  verification_invalid_transition:
    "Status verifikasi ini tidak dapat diubah ke pilihan tersebut. Muat ulang halaman untuk melihat status terbaru.",
  verification_transition_conflict:
    "Status verifikasi sudah berubah. Muat ulang halaman lalu coba lagi.",
  submission_not_found: "Pengajuan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  submission_already_reviewed:
    "Pengajuan ini sudah ditinjau. Muat ulang halaman untuk melihat hasilnya.",
  // A closure refusal has one sentence per cause, under the key <code>:<cause>.
  "institution_tick_closed_needs_documents:staff":
    "Centang ruang kerja ini dicabut atau ditolak staf, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "institution_tick_closed_needs_documents:automatic":
    "Centang ruang kerja ini hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "institution_tick_path_a_closed:staff":
    "Centang ruang kerja ini dicabut atau ditolak staf, jadi centang hanya bisa didapat lagi lewat dokumen.",
  "institution_tick_path_a_closed:automatic":
    "Centang ruang kerja ini hilang karena nama atau situs webnya diubah saat bukti nama berjalan, atau karena bukti nama tidak dikirim tepat waktu, jadi centang hanya bisa didapat lagi lewat dokumen.",
  institution_tick_live_paid_competition:
    "Ruang kerja ini punya kompetisi berbayar yang sedang tayang, jadi centang hanya bisa didapat lagi lewat dokumen agar staf memeriksa namanya.",
  institution_name_proof_needs_documents:
    "Selama bukti nama berjalan, nama ruang kerja hanya dapat dibuktikan lewat dokumen. Kirim dokumen sebelum batas waktunya.",
  institution_name_check_reason_required:
    "Tulis alasan menerima nama ini, karena bukti nama sedang berjalan.",
  institution_name_check_not_applicable:
    "Ruang kerja ini tidak lagi perlu diperiksa namanya. Muat ulang halaman untuk melihat antrean terbaru.",
  institution_name_proof_running:
    "Bukti nama ruang kerja ini sudah berjalan. Muat ulang halaman untuk melihat antrean terbaru.",
  institution_name_check_reason_invalid: "Isi alasan, paling banyak 1000 karakter.",
};

// A refusal that carries a cause is looked up as <code>:<cause> first, then as <code>.
export const resolveVerificationRefusalMessage = (
  error: { code?: string; message?: string; details?: { cause?: unknown } } | undefined,
  fallback: string,
): string => {
  const messageForCode = errorMessageFor(error?.code, VERIFICATION_REFUSAL_COPY, fallback);
  const cause = error?.details?.cause;
  if (typeof cause !== "string") return messageForCode;

  return errorMessageFor(`${error?.code}:${cause}`, VERIFICATION_REFUSAL_COPY, messageForCode);
};
