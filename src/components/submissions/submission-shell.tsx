"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type ClientSubmission = {
  fileName: string;
  fileKey: string;
  version: number;
  finalizedAt: string | null;
} | null;

type SubmissionStep = "upload-url" | "save" | "finalize";

type SubmissionShellProps = {
  expectedUserId: string;
  competitionId: string;
  registrationId: string;
  windowOpen: boolean;
  registrationCancelled: boolean;
  initialSubmission: ClientSubmission;
};

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
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);

  useEffect(() => {
    if (registrationCancelled) {
      addToast({ type: "error", message: "Pendaftaran dibatalkan — submission ditutup." });
    } else if (!windowOpen) {
      addToast({
        type: "warning",
        message: "Jendela submission belum dibuka atau sudah ditutup.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationCancelled, windowOpen]);

  const [fileKey, setFileKey] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileSizeBytes, setFileSizeBytes] = useState("");
  const [fileMimeType, setFileMimeType] = useState("");

  const finalized = Boolean(submission?.finalizedAt);
  const url = baseUrl(competitionId, registrationId);
  const requiredPrefix = `submissions/${registrationId}/`;

  const surfaceError = async (res: Response) => {
    const code = await readErrorCode(res);
    if (code === SESSION_MISMATCH_CODE) {
      addToast({ type: "error", message: SESSION_MISMATCH_MESSAGE });
    } else {
      addToast({
        type: "error",
        message: code ? `Error: ${code}` : `Error (HTTP ${res.status})`,
      });
    }
  };

  const requestUploadUrl = async () => {
    setUploadUrl(null);
    setPendingStep("upload-url");
    try {
      const res = await sessionFetch(expectedUserId, `${url}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName: fileName || "submission",
          fileMimeType: fileMimeType || null,
        }),
      });
      if (!res.ok) {
        await surfaceError(res);
        return;
      }
      const body = (await res.json()) as { uploadUrl: string; fileKey: string };
      setUploadUrl(body.uploadUrl);
      setFileKey(body.fileKey);
      addToast({
        type: "success",
        message: "Berkas siap diunggah.",
      });
    } catch {
      addToast({ type: "error", message: "Gangguan koneksi. Coba lagi." });
    } finally {
      setPendingStep(null);
    }
  };

  const saveSubmission = async () => {
    setPendingStep("save");
    try {
      const payload: Record<string, unknown> = { fileKey, fileName };
      if (fileSizeBytes.trim().length > 0) payload.fileSizeBytes = Number(fileSizeBytes);
      if (fileMimeType.trim().length > 0) payload.fileMimeType = fileMimeType.trim();

      const res = await sessionFetch(expectedUserId, url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await surfaceError(res);
        return;
      }
      const body = (await res.json()) as { submission: unknown };
      setSubmission(toClientSubmission(body.submission));
      addToast({ type: "success", message: "Submission tersimpan." });
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
        await surfaceError(res);
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
            <p className="eyebrow">Status saat ini</p>
            <h2>Status submission</h2>
          </div>
          <span
            className="status-badge"
            data-status={finalized ? "closed" : submission ? "open" : undefined}
          >
            {finalized ? "Final" : submission ? "Draft" : "Belum dimulai"}
          </span>
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
        <section className="content-section submission-step">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">01</span>
            <div>
              <p className="eyebrow">Unggah berkas</p>
              <h2>Siapkan unggahan berkas</h2>
            </div>
          </div>
          <Button
            type="button"
            onClick={requestUploadUrl}
            loading={pendingStep === "upload-url"}
            disabled={loading}
            variant="outline"
            size="md"
          >
            Siapkan unggahan
          </Button>
          {uploadUrl ? <p className="submission-url data-text">Upload URL: {uploadUrl}</p> : null}
        </section>
      ) : null}

      {!finalized && !registrationCancelled && windowOpen ? (
        <section className="content-section submission-step">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">02</span>
            <div>
              <h2>Simpan metadata submission</h2>
            </div>
          </div>
          <p className="form-help">
            fileKey harus diawali dengan <code>{requiredPrefix}</code>
          </p>
          <label className="form-field">
            <span className="form-label">fileKey</span>
            <input
              className="form-input"
              value={fileKey}
              onChange={(e) => setFileKey(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-label">fileName</span>
            <input
              className="form-input"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-label">fileSizeBytes (Opsional)</span>
            <input
              className="form-input"
              value={fileSizeBytes}
              onChange={(e) => setFileSizeBytes(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="form-field">
            <span className="form-label">fileMimeType (Opsional)</span>
            <input
              className="form-input"
              value={fileMimeType}
              onChange={(e) => setFileMimeType(e.target.value)}
            />
          </label>
          <Button
            type="button"
            onClick={saveSubmission}
            loading={pendingStep === "save"}
            disabled={loading}
            variant="primary"
            size="md"
          >
            Simpan submission
          </Button>
        </section>
      ) : null}

      {submission && !finalized && !registrationCancelled ? (
        <section className="content-section submission-step submission-finalize">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">03</span>
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
            variant="secondary"
            size="md"
          >
            Finalisasi submission
          </Button>
        </section>
      ) : null}
    </div>
  );
};
