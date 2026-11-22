import type { RegistrationDocumentErrorCode } from "@/server/registration-documents/registration-document-core";

const DOCUMENT_REQUEST_ERROR_COPY: Partial<Record<RegistrationDocumentErrorCode, string>> = {
  document_request_invalid_value: "Periksa isian formulir lalu coba lagi.",
  document_request_already_open:
    "Peserta ini sudah memiliki permintaan yang berjalan. Selesaikan permintaan tersebut sebelum membuat yang baru.",
  document_request_not_found: "Permintaan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  document_request_wrong_status:
    "Status permintaan ini sudah berubah. Muat ulang halaman lalu coba lagi.",
};

export function resolveDocumentRequestErrorMessage(
  code: string | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  return DOCUMENT_REQUEST_ERROR_COPY[code as RegistrationDocumentErrorCode] ?? fallback;
}
