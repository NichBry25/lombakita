"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Button, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import {
  preValidateSubmissionFile,
  SUBMISSION_ACCEPT_ATTRIBUTE,
  SUBMISSION_FORMAT_HINT,
  SUBMISSION_MAX_BYTES,
} from "@/lib/submissions/submission-file";

type ClientSubmission = {
  fileName: string;
  fileKey: string;
  version: number;
  finalizedAt: string | null;
} | null;

type SubmissionStep = "upload" | "finalize";

type SubmissionShellProps = {
  expectedUserId: string;
  competitionId: string;
  registrationId: string;
  windowOpen: boolean;
  registrationCancelled: boolean;
  initialSubmission: ClientSubmission;
};

const SUBMISSION_MAX_MEGABYTES = SUBMISSION_MAX_BYTES / (1024 * 1024);

const SUBMISSION_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
  submission_invalid_payload: "Data berkas tidak lengkap. Pilih berkas lagi lalu unggah ulang.",
  submission_invalid_file_key:
    "Unggahan tidak cocok dengan pendaftaran ini. Muat ulang halaman lalu unggah ulang.",
  submission_registration_not_found: "Pendaftaran tidak ditemukan.",
  submission_registration_cancelled: "Pendaftaran dibatalkan, jadi submission ditutup.",
  submission_window_closed: "Jendela submission belum dibuka atau sudah ditutup.",
  submission_file_missing: "Berkas belum selesai terunggah. Unggah ulang berkas Anda.",
  submission_finalized: "Submission sudah difinalisasi dan tidak dapat diubah.",
  submission_not_found: "Unggah berkas terlebih dahulu sebelum finalisasi.",
  submission_upload_unavailable: "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
};

const UPLOAD_URL_ERROR_COPY: Partial<Record<string, string>> = {
  ...SUBMISSION_ERROR_COPY,
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
  submission_invalid_file_type: `Format tidak didukung. Unggah ${SUBMISSION_FORMAT_HINT}, atau kemas berkas Anda sebagai ZIP.`,
};

const RECORD_ERROR_COPY: Partial<Record<string, string>> = {
  ...SUBMISSION_ERROR_COPY,
  submission_invalid_file_type: `Berkas tidak lolos pemeriksaan. Pastikan formatnya didukung, tidak kosong, dan tidak melebihi ${SUBMISSION_MAX_MEGABYTES} MB.`,
};

const UPLOAD_URL_FALLBACK = "Gagal menyiapkan unggahan. Coba lagi.";
const RECORD_FALLBACK = "Gagal menyimpan berkas. Coba lagi.";
const FINALIZE_FALLBACK = "Gagal memfinalisasi submission. Coba lagi.";

const baseUrl = (competitionId: string, registrationId: string): string =>
  `/api/v1/competitions/${competitionId}/registrations/${registrationId}/submission`;

const toClientSubmission = (raw: unknown): ClientSubmission => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    fileName: String(r.fileName ?? ""),
    fileKey: String(r.fileKey ?? ""),
    version: typeof r.version === "number" ? r.version : Number(r.version ?? 1),
    finalizedAt: r.finalizedAt ? String(r.finalizedAt) : null,
  };
};

export const SubmissionShell = ({
  expectedUserId,
  competitionId,
  registrationId,
  windowOpen,
  registrationCancelled,
  initialSubmission,
}: SubmissionShellProps) => {
  const [submission, setSubmission] = useState<ClientSubmission>(initialSubmission);
  const { addToast } = useToast();
  // Three independent steps share this component; tracking which one is running keeps the
  // spinner on the pressed step while the other steps stay locked.
  const [pendingStep, setPendingStep] = useState<SubmissionStep | null>(null);
  const loading = pendingStep !== null;

  useEffect(() => {
    if (registrationCancelled) {
      addToast({ type: "error", message: "Pendaftaran dibatalkan, jadi submission ditutup." });
    } else if (!windowOpen) {
      addToast({
        type: "warning",
        message: "Jendela submission belum dibuka atau sudah ditutup.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationCancelled, windowOpen]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const finalized = Boolean(submission?.finalizedAt);
  const url = baseUrl(competitionId, registrationId);
  const fileInputId = `submission-file-${registrationId}`;

  const surfaceError = async (
    res: Response,
    surfaceCopy: Partial<Record<string, string>>,
    fallback: string,
  ) => {
    const code = await readErrorCode(res);
    addToast({ type: "error", message: errorMessageFor(code, surfaceCopy, fallback) });
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const problem = preValidateSubmissionFile({ name: file.name, size: file.size });
      if (problem) {
        addToast({ type: "error", message: problem });
        event.target.value = "";
        setSelectedFile(null);
        return;
      }
    }
    setSelectedFile(file);
  };

  // Presign, PUT the bytes to R2, then record the metadata. The server confirms the stored file
  // against its own bytes in that last step, so a file the browser accepted can still be refused.
  const uploadFile = async () => {
    if (!selectedFile || loading) return;

    setPendingStep("upload");
    try {
      const presign = await sessionFetch(expectedUserId, `${url}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: selectedFile.name }),
      });
      if (!presign.ok) {
        await surfaceError(presign, UPLOAD_URL_ERROR_COPY, UPLOAD_URL_FALLBACK);
        return;
      }
      const { uploadUrl, fileKey, contentType } = (await presign.json()) as {
        uploadUrl: string;
        fileKey: string;
        contentType: string;
      };

      // The content type must match the one bound into the signed URL or R2 rejects the signature.
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: selectedFile,
      });
      if (!put.ok) {
        addToast({ type: "error", message: "Unggahan ke penyimpanan gagal. Coba lagi." });
        return;
      }

      const record = await sessionFetch(expectedUserId, url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileKey,
          fileName: selectedFile.name,
          fileSizeBytes: selectedFile.size,
        }),
      });
      if (!record.ok) {
        await surfaceError(record, RECORD_ERROR_COPY, RECORD_FALLBACK);
        return;
      }

      const body = (await record.json()) as { submission: unknown };
      setSubmission(toClientSubmission(body.submission));
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      addToast({ type: "success", message: "Berkas terunggah." });
    } catch {
      addToast({ type: "error", message: "Gangguan koneksi. Coba lagi." });
    } finally {
      setPendingStep(null);
    }
  };

  const finalizeSubmission = async () => {
    setPendingStep("finalize");
    try {
      const res = await sessionFetch(expectedUserId, `${url}/finalize`, { method: "POST" });
      if (!res.ok) {
        await surfaceError(res, SUBMISSION_ERROR_COPY, FINALIZE_FALLBACK);
        return;
      }
      const body = (await res.json()) as { submission: unknown };
      setSubmission(toClientSubmission(body.submission));
      addToast({ type: "success", message: "Submission difinalisasi." });
    } catch {
      addToast({ type: "error", message: "Gangguan koneksi. Coba lagi." });
    } finally {
      setPendingStep(null);
    }
  };

  return (
    <div className="submission-shell">
      <section className="content-section submission-status">
        <div className="section-heading">
          <div>
            <h2>Status submission</h2>
          </div>
        </div>
        {submission ? (
          <dl className="submission-summary">
            <div>
              <dt>Nama berkas</dt>
              <dd>{submission.fileName}</dd>
            </div>
            <div>
              <dt>Versi</dt>
              <dd className="data-text">{submission.version}</dd>
            </div>
            <div>
              <dt>Final</dt>
              <dd>{finalized ? "Ya (terkunci)" : "Belum"}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted-copy">Belum ada submission.</p>
        )}
      </section>

      {!finalized && !registrationCancelled && windowOpen ? (
        <section className="content-section surface-card card-padding submission-step">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">01</span>
            <div>
              <h2>{submission ? "Ganti berkas" : "Unggah karya Anda"}</h2>
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor={fileInputId}>
              Berkas karya
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
              id={fileInputId}
              ref={fileInputRef}
              type="file"
              accept={SUBMISSION_ACCEPT_ATTRIBUTE}
              onChange={handleFileSelect}
              className="sr-only"
              aria-describedby={`${fileInputId}-hint`}
            />
            <p className="form-help" id={`${fileInputId}-hint`}>
              {SUBMISSION_FORMAT_HINT} (maks. 50 MB). Kemas beberapa berkas sebagai ZIP.
            </p>
          </div>

          {submission ? (
            <p className="muted-copy">
              Mengunggah berkas baru akan menggantikan berkas sebelumnya sampai Anda memfinalisasi.
            </p>
          ) : null}

          <Button
            type="button"
            onClick={() => void uploadFile()}
            loading={pendingStep === "upload"}
            disabled={!selectedFile}
            variant="primary"
            size="md"
          >
            Unggah berkas
          </Button>
        </section>
      ) : null}

      {submission && !finalized && !registrationCancelled ? (
        <section className="content-section submission-step submission-finalize">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">02</span>
            <div>
              <h2>Finalisasi</h2>
            </div>
          </div>
          <p className="muted-copy">Setelah difinalisasi, submission tidak dapat diubah.</p>
          <Button
            type="button"
            onClick={finalizeSubmission}
            loading={pendingStep === "finalize"}
            disabled={loading}
            variant="primary"
            size="md"
          >
            Finalisasi submission
          </Button>
        </section>
      ) : null}
    </div>
  );
};
