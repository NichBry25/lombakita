"use client";

import { ChangeEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Feedback, Icon, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
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

const formatFileSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const formatDeadline = (isoDate: string): string =>
  new Date(isoDate).toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

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
        const payload = (await presign.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Gagal menyiapkan unggahan. Coba lagi.",
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
        const payload = (await finalize.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Berkas ditolak saat verifikasi. Coba berkas lain.",
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
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Gagal menghapus dokumen. Coba lagi.",
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
        <time dateTime={request.dueAt} className="data-text">
          {formatDeadline(request.dueAt)}
        </time>
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
                    variant="danger"
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
          <label className="form-label" htmlFor={inputId}>
            Lampirkan dokumen
          </label>
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
