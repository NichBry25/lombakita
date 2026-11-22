"use client";

import { ChangeEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Feedback, FormLabel, Icon, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";
import {
  getFileExtension,
  mimeTypeForExtension,
  preValidateVerificationDocument,
} from "@/lib/recruiter-verification/verification-document";
import {
  DOCUMENT_REQUEST_STATUS_LABELS,
  DOCUMENT_REQUEST_STATUS_TONES,
  type RegistrationDocumentDisplayStatus,
} from "@/lib/registration-documents/request-status";
import { formatFileSize } from "@/lib/text/format-file-size";

export type CandidateDocumentRequest = {
  id: string;
  title: string;
  instructions: string | null;
  dueAt: string;
  status: "requested" | "submitted" | "accepted" | "rejected" | "cancelled";
  displayStatus: RegistrationDocumentDisplayStatus;
  isOverdue: boolean;
  isLate: boolean;
  reviewNote: string | null;
  files: Array<{
    id: string;
    originalFileName: string;
    fileSizeBytes: number;
    createdAt: string;
  }>;
};

type SurfaceCopy = Partial<Record<string, string>>;

const DOCUMENT_FILE_ERROR_COPY: SurfaceCopy = {
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
  document_request_invalid_value: "Data berkas tidak lengkap. Pilih berkas lagi lalu unggah ulang.",
  document_request_file_type_not_allowed: "Format tidak didukung. Unggah PDF, JPG, PNG, atau WebP.",
  document_request_file_invalid: "Berkas ditolak saat verifikasi. Coba berkas lain.",
  document_request_file_too_large: "Ukuran berkas melebihi batas 10 MB.",
  document_request_not_found: "Permintaan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  document_request_wrong_status:
    "Status permintaan ini sudah berubah. Muat ulang halaman lalu coba lagi.",
  document_request_storage_unavailable: "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
};

const DOCUMENT_UPLOAD_URL_ERROR_COPY: SurfaceCopy = {
  ...DOCUMENT_FILE_ERROR_COPY,
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
};

// On finalize a missing file means the upload never landed; on delete it means the row is gone.
const DOCUMENT_FINALIZE_ERROR_COPY: SurfaceCopy = {
  ...DOCUMENT_FILE_ERROR_COPY,
  document_request_file_not_found: "Berkas belum selesai terunggah. Unggah ulang berkas Anda.",
};

const DOCUMENT_DELETE_ERROR_COPY: SurfaceCopy = {
  ...DOCUMENT_FILE_ERROR_COPY,
  document_request_file_not_found: "Dokumen tidak ditemukan. Muat ulang halaman.",
};

const DOCUMENT_UPLOAD_URL_FALLBACK = "Gagal menyiapkan unggahan. Coba lagi.";
const DOCUMENT_FINALIZE_FALLBACK = "Gagal menyimpan dokumen. Coba lagi.";
const DOCUMENT_DELETE_FALLBACK = "Gagal menghapus dokumen. Coba lagi.";

const refusalMessage = async (
  response: Response,
  surfaceCopy: SurfaceCopy,
  fallback: string,
): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return errorMessageFor(payload?.error?.code, surfaceCopy, fallback);
};

// Uploading and removing are both possible only while the request is open. Once a verdict lands
// the document is frozen — it is the evidence that verdict rests on.
const canUpload = (status: CandidateDocumentRequest["status"]): boolean =>
  status === "requested" || status === "submitted";
const canRemoveFiles = canUpload;

/**
 * The candidate's side of a document request.
 *
 * Nothing here gates anything — the registration stays active and submittable whatever the request
 * says — so the panel leads with what is being asked rather than with a warning. The reviewer's
 * reason renders as persistent page content, never a toast: it is the instruction the candidate
 * works from, so it has to survive a reload.
 */
export function CandidateDocumentRequestPanel({
  expectedUserId,
  requests,
}: {
  expectedUserId: string;
  requests: CandidateDocumentRequest[];
}) {
  if (requests.length === 0) return null;

  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>Dokumen diminta</h2>
      </div>
      <p className="muted-copy">
        Penyelenggara meminta dokumen untuk memastikan Anda memenuhi ketentuan lomba. Pendaftaran
        Anda tetap aktif selama proses ini.
      </p>

      <ul className="record-list">
        {requests.map((request) => (
          <li className="record-row" key={request.id}>
            <DocumentRequestCard expectedUserId={expectedUserId} request={request} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocumentRequestCard({
  expectedUserId,
  request,
}: {
  expectedUserId: string;
  request: CandidateDocumentRequest;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  // Keyed by file id so the spinner stays on the control that was pressed rather than every row.
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);

  const uploadable = canUpload(request.status);
  const removable = canRemoveFiles(request.status);

  const inputId = `document-request-${request.id}-file`;
  const headingId = `document-request-${request.id}-title`;
  const instructionsId = `document-request-${request.id}-instructions`;

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const problem = preValidateVerificationDocument({
        name: file.name,
        type: file.type,
        size: file.size,
      });
      if (problem) {
        addToast({ type: "error", message: problem });
        event.target.value = "";
        setSelectedFile(null);
        return;
      }
    }
    setSelectedFile(file);
  };

  const uploadFile = async () => {
    if (!selectedFile || uploadBusy) return;

    // Derived from the extension so it matches what the presigned PUT binds and what the server
    // re-derives from the bytes — the browser's own file.type can be empty.
    const contentType = mimeTypeForExtension(getFileExtension(selectedFile.name));
    if (!contentType) {
      addToast({
        type: "error",
        message: "Format tidak didukung. Unggah PDF, JPG, PNG, atau WebP.",
      });
      return;
    }

    setUploadBusy(true);
    try {
      const presign = await sessionFetch(
        expectedUserId,
        `/api/v1/me/document-requests/${request.id}/files`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            originalFileName: selectedFile.name,
            contentType,
            fileSizeBytes: selectedFile.size,
          }),
        },
      );

      if (!presign.ok) {
        addToast({
          type: "error",
          message: await refusalMessage(
            presign,
            DOCUMENT_UPLOAD_URL_ERROR_COPY,
            DOCUMENT_UPLOAD_URL_FALLBACK,
          ),
        });
        return;
      }

      const { uploadUrl, r2Key } = (await presign.json()) as { uploadUrl: string; r2Key: string };

      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: selectedFile,
      });

      if (!put.ok) {
        addToast({ type: "error", message: "Unggahan ke penyimpanan gagal. Coba lagi." });
        return;
      }

      const finalize = await sessionFetch(
        expectedUserId,
        `/api/v1/me/document-requests/${request.id}/files/finalize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ r2Key, originalFileName: selectedFile.name }),
        },
      );

      if (!finalize.ok) {
        addToast({
          type: "error",
          message: await refusalMessage(
            finalize,
            DOCUMENT_FINALIZE_ERROR_COPY,
            DOCUMENT_FINALIZE_FALLBACK,
          ),
        });
        return;
      }

      addToast({ type: "success", message: "Dokumen berhasil diunggah." });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Unggahan gagal karena gangguan koneksi." });
    } finally {
      setUploadBusy(false);
    }
  };

  const removeFile = async (fileId: string, fileName: string) => {
    setDeletingFileId(fileId);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/me/document-requests/${request.id}/files/${fileId}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        addToast({
          type: "error",
          message: await refusalMessage(
            response,
            DOCUMENT_DELETE_ERROR_COPY,
            DOCUMENT_DELETE_FALLBACK,
          ),
        });
        return;
      }

      addToast({ type: "success", message: `${fileName} dihapus.` });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal menghapus dokumen karena gangguan koneksi." });
    } finally {
      setDeletingFileId(null);
    }
  };

  return (
    <div className="record-row-main" aria-labelledby={headingId}>
      <div className="section-heading">
        <p className="record-row-title" id={headingId}>
          {request.title}
        </p>
        <span
          className="status-badge"
          data-status={DOCUMENT_REQUEST_STATUS_TONES[request.displayStatus]}
        >
          {DOCUMENT_REQUEST_STATUS_LABELS[request.displayStatus]}
        </span>
      </div>

      <span className="record-meta">
        Batas waktu{" "}
        <span className="data-text">
          <LocalDate value={request.dueAt} format="longDateTime" />
        </span>
        {request.isLate ? " · Dikirim setelah batas waktu" : ""}
      </span>

      {request.instructions ? (
        <p className="muted-copy" id={instructionsId}>
          {request.instructions}
        </p>
      ) : null}

      {/* The reviewer's reason is the instruction the candidate acts on, so it is page content
          rather than a toast. */}
      {request.reviewNote && request.status !== "accepted" ? (
        <Feedback tone={request.status === "rejected" ? "error" : "warning"}>
          {request.status === "rejected"
            ? `Dokumen ditolak. Alasan: ${request.reviewNote}`
            : `Perlu diunggah ulang. Alasan: ${request.reviewNote}`}
        </Feedback>
      ) : null}

      {request.isOverdue ? (
        <Feedback tone="warning">
          Batas waktu sudah lewat. Anda masih dapat mengunggah, tetapi penyelenggara sudah dapat
          mengambil keputusan.
        </Feedback>
      ) : null}

      {request.files.length > 0 ? (
        <ul className="record-list">
          {request.files.map((file) => (
            <li className="record-row" key={file.id}>
              <div className="record-row-main">
                <p className="record-row-title">{file.originalFileName}</p>
                <span className="record-meta">{formatFileSize(file.fileSizeBytes)}</span>
              </div>
              {removable ? (
                <div className="record-actions">
                  <IconButton
                    label={`Hapus ${file.originalFileName}`}
                    icon="trash"
                    variant="outline"
                    loading={deletingFileId === file.id}
                    onClick={() => void removeFile(file.id, file.originalFileName)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {uploadable ? (
        <div className="form-field">
          <FormLabel htmlFor={inputId} required>
            Lampirkan dokumen
          </FormLabel>
          <div className="pf-media-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
            >
              Pilih berkas
            </Button>
            <span className="form-help">
              {selectedFile ? selectedFile.name : "Belum ada berkas yang dipilih"}
            </span>
          </div>
          <input
            id={inputId}
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            onChange={handleFileSelect}
            className="sr-only"
            aria-describedby={request.instructions ? instructionsId : undefined}
          />
          <p className="form-help">PDF, JPG, PNG, atau WebP (maks. 10 MB).</p>
          <Button
            type="button"
            disabled={!selectedFile}
            loading={uploadBusy}
            onClick={() => void uploadFile()}
          >
            Unggah dokumen
          </Button>
        </div>
      ) : null}
    </div>
  );
}
