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
      setFeedback({ type: "error", message: code ? `Error: ${code}` : `Error (HTTP ${res.status})` });
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
        body: JSON.stringify({ fileName: fileName || "submission", fileMimeType: fileMimeType || null }),
      });
      if (!res.ok) {
        await surfaceError(res);
        return;
      }
      const body = (await res.json()) as { uploadUrl: string; fileKey: string };
      setUploadUrl(body.uploadUrl);
      setFileKey(body.fileKey);
      setFeedback({ type: "success", message: "Upload URL berhasil dibuat. Salin fileKey di bawah." });
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
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Current state */}
      <section style={{ padding: "0.75rem", background: "#f5f5f5", borderRadius: 4 }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Status Submission</h2>
        {submission ? (
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li>Nama berkas: {submission.fileName}</li>
            <li>Versi: {submission.version}</li>
            <li>Final: {finalized ? "Ya (terkunci)" : "Belum"}</li>
          </ul>
        ) : (
          <p style={{ margin: 0, color: "#777" }}>Belum ada submission.</p>
        )}
      </section>

      {registrationCancelled ? (
        <p style={{ color: "#c00" }}>Pendaftaran dibatalkan — submission ditutup.</p>
      ) : !windowOpen ? (
        <p style={{ color: "#c00" }}>Jendela submission belum dibuka atau sudah ditutup.</p>
      ) : null}

      {feedback ? (
        <p style={{ color: feedback.type === "error" ? "#c00" : "#060", fontWeight: 500 }}>
          {feedback.message}
        </p>
      ) : null}

      {/* Upload URL request */}
      {!finalized && !registrationCancelled && windowOpen ? (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>1. Minta Upload URL (R2)</h2>
          <button type="button" onClick={requestUploadUrl} disabled={loading}>
            Minta Upload URL
          </button>
          {uploadUrl ? (
            <p style={{ fontSize: "0.8rem", wordBreak: "break-all", color: "#355795" }}>
              Upload URL: {uploadUrl}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Record metadata */}
      {!finalized && !registrationCancelled && windowOpen ? (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>2. Simpan Metadata Submission</h2>
          <p style={{ fontSize: "0.8rem", color: "#777", margin: 0 }}>
            fileKey harus diawali dengan <code>{requiredPrefix}</code>
          </p>
          <label>
            fileKey
            <input value={fileKey} onChange={(e) => setFileKey(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label>
            fileName
            <input value={fileName} onChange={(e) => setFileName(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label>
            fileSizeBytes (opsional)
            <input
              value={fileSizeBytes}
              onChange={(e) => setFileSizeBytes(e.target.value)}
              inputMode="numeric"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            fileMimeType (opsional)
            <input
              value={fileMimeType}
              onChange={(e) => setFileMimeType(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <button type="button" onClick={saveSubmission} disabled={loading}>
            Simpan Submission
          </button>
        </section>
      ) : null}

      {/* Finalize */}
      {submission && !finalized && !registrationCancelled ? (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>3. Finalisasi</h2>
          <p style={{ fontSize: "0.8rem", color: "#777", margin: 0 }}>
            Setelah difinalisasi, submission tidak dapat diubah.
          </p>
          <button type="button" onClick={finalizeSubmission} disabled={loading}>
            Finalisasi Submission
          </button>
        </section>
      ) : null}
    </div>
  );
};
