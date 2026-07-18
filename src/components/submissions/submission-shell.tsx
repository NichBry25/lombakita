"use client";

import { useState } from "react";
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

type Feedback = { type: "error" | "success"; message: string } | null;

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
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loading, setLoading] = useState(false);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);

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
      setFeedback({ type: "error", message: SESSION_MISMATCH_MESSAGE });
    } else {
      setFeedback({
        type: "error",
        message: code ? `Error: ${code}` : `Error (HTTP ${res.status})`,
      });
    }
  };

  const requestUploadUrl = async () => {
    setFeedback(null);
    setUploadUrl(null);
    setLoading(true);
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
      setFeedback({
        type: "success",
        message: "Upload URL berhasil dibuat. Salin fileKey di bawah.",
      });
    } catch {
      setFeedback({ type: "error", message: "Network error" });
    } finally {
      setLoading(false);
    }
  };

  const saveSubmission = async () => {
    setFeedback(null);
    setLoading(true);
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
      setFeedback({ type: "success", message: "Submission tersimpan." });
    } catch {
      setFeedback({ type: "error", message: "Network error" });
    } finally {
      setLoading(false);
    }
  };

  const finalizeSubmission = async () => {
    setFeedback(null);
    setLoading(true);
    try {
      const res = await sessionFetch(expectedUserId, `${url}/finalize`, { method: "POST" });
      if (!res.ok) {
        await surfaceError(res);
        return;
      }
      const body = (await res.json()) as { submission: unknown };
      setSubmission(toClientSubmission(body.submission));
      setFeedback({ type: "success", message: "Submission difinalisasi." });
    } catch {
      setFeedback({ type: "error", message: "Network error" });
    } finally {
      setLoading(false);
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

      {registrationCancelled ? (
        <p className="feedback" data-tone="error">
          Pendaftaran dibatalkan — submission ditutup.
        </p>
      ) : !windowOpen ? (
        <p className="feedback" data-tone="warning">
          Jendela submission belum dibuka atau sudah ditutup.
        </p>
      ) : null}

      {feedback ? (
        <p className="feedback" data-tone={feedback.type === "error" ? "error" : "success"}>
          {feedback.message}
        </p>
      ) : null}

      {!finalized && !registrationCancelled && windowOpen ? (
        <section className="content-section submission-step">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">01</span>
            <div>
              <p className="eyebrow">Unggah berkas</p>
              <h2>Minta upload URL (R2)</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={requestUploadUrl}
            disabled={loading}
            className="ui-button"
            data-variant="outline"
            data-size="md"
          >
            Minta Upload URL
          </button>
          {uploadUrl ? <p className="submission-url data-text">Upload URL: {uploadUrl}</p> : null}
        </section>
      ) : null}

      {!finalized && !registrationCancelled && windowOpen ? (
        <section className="content-section submission-step">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">02</span>
            <div>
              <p className="eyebrow">Metadata</p>
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
            <span className="form-label">fileSizeBytes (opsional)</span>
            <input
              className="form-input"
              value={fileSizeBytes}
              onChange={(e) => setFileSizeBytes(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label className="form-field">
            <span className="form-label">fileMimeType (opsional)</span>
            <input
              className="form-input"
              value={fileMimeType}
              onChange={(e) => setFileMimeType(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={saveSubmission}
            disabled={loading}
            className="ui-button"
            data-variant="primary"
            data-size="md"
          >
            Simpan Submission
          </button>
        </section>
      ) : null}

      {submission && !finalized && !registrationCancelled ? (
        <section className="content-section submission-step submission-finalize">
          <div className="submission-step-heading">
            <span className="submission-step-number data-text">03</span>
            <div>
              <p className="eyebrow">Kunci submission</p>
              <h2>Finalisasi</h2>
            </div>
          </div>
          <p className="muted-copy">Setelah difinalisasi, submission tidak dapat diubah.</p>
          <button
            type="button"
            onClick={finalizeSubmission}
            disabled={loading}
            className="ui-button"
            data-variant="gold"
            data-size="md"
          >
            Finalisasi Submission
          </button>
        </section>
      ) : null}
    </div>
  );
};
