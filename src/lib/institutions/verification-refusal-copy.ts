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
};

export const resolveVerificationRefusalMessage = (
  error: { code?: string; message?: string } | undefined,
  fallback: string,
): string => errorMessageFor(error?.code, VERIFICATION_REFUSAL_COPY, fallback);
