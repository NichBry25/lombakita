"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { sessionFetch } from "@/lib/session/session-fetch";
import {
  getFileExtension,
  mimeTypeForExtension,
  preValidateVerificationDocument,
} from "@/lib/recruiter-verification/verification-document";

type SubmissionStatus = "pending_review" | "approved" | "rejected";

type Submission = {
  id: string;
  status: SubmissionStatus;
  rejectionReason: string | null;
  corporateEmail: string | null;
  vouchedAt: string | null;
};

type DocumentEntry = { id: string; originalFileName: string };

type PanelProps = {
  userId: string;
  isTrusted: boolean;
  submission: Submission | null;
  documents: DocumentEntry[];
};

// Recruiter trust status panel. Renders one of four states: Trusted (publishing unlocked),
// pending review (with optional affiliation-document upload), rejected (reason + re-submit), or
// no submission yet (submit the affiliation form — the OAuth-signup entry point). Every mutation
// goes through sessionFetch per the cross-session guard (Rule 16).
export function RecruiterVerificationPanel({
  userId,
  isTrusted,
  submission,
  documents,
}: PanelProps) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  const [fullName, setFullName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [corporateEmail, setCorporateEmail] = useState("");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

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

  const uploadDocument = async () => {
    if (!selectedFile || uploadBusy) return;

    // The content type is derived from the extension so it matches what the presigned PUT binds and
    // what the server re-derives from the bytes — the browser's own file.type can be empty.
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
      const presignResponse = await sessionFetch(
        userId,
        "/api/v1/recruiter/me/verification/documents",
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

      if (!presignResponse.ok) {
        const payload = (await presignResponse.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Gagal menyiapkan unggahan. Coba lagi.",
        });
        return;
      }

      const { uploadUrl, r2Key } = (await presignResponse.json()) as {
        uploadUrl: string;
        r2Key: string;
      };

      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: selectedFile,
      });

      if (!putResponse.ok) {
        addToast({ type: "error", message: "Unggahan ke penyimpanan gagal. Coba lagi." });
        return;
      }

      const finalizeResponse = await sessionFetch(
        userId,
        "/api/v1/recruiter/me/verification/documents/finalize",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ r2Key, originalFileName: selectedFile.name }),
        },
      );

      if (!finalizeResponse.ok) {
        const payload = (await finalizeResponse.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Berkas ditolak saat verifikasi. Coba berkas lain.",
        });
        return;
      }

      addToast({ type: "success", message: "Dokumen berhasil dilampirkan." });
      window.location.reload();
    } catch {
      addToast({ type: "error", message: "Unggahan gagal karena gangguan koneksi." });
    } finally {
      setUploadBusy(false);
    }
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (fullName.trim().length < 2) {
      addToast({ type: "error", message: "Isi nama lengkap (minimal 2 karakter)." });
      return;
    }
    if (mobileNumber.replace(/\D/g, "").length < 8) {
      addToast({ type: "error", message: "Isi nomor ponsel yang valid (minimal 8 digit)." });
      return;
    }

    setBusy(true);
    try {
      const response = await sessionFetch(userId, "/api/v1/recruiter/me/verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          mobileNumber: mobileNumber.trim(),
          corporateEmail: corporateEmail.trim() || null,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Pengiriman gagal. Coba lagi beberapa saat.",
        });
        return;
      }

      addToast({ type: "success", message: "Terkirim. Akun Anda menunggu peninjauan." });
      window.location.reload();
    } catch {
      addToast({ type: "error", message: "Pengiriman gagal karena gangguan koneksi." });
    } finally {
      setBusy(false);
    }
  };

  if (isTrusted) {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Kredibilitas penyelenggara</p>
            <h2>Rekruter Terpercaya</h2>
          </div>
          <span className="status-badge" data-status="open">
            Terverifikasi
          </span>
        </div>
        <p className="muted-copy">
          Akun Anda telah diverifikasi. Anda kini dapat mempublikasikan kompetisi.
        </p>
      </section>
    );
  }

  if (submission?.status === "pending_review") {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Kredibilitas penyelenggara</p>
            <h2>Menunggu peninjauan</h2>
          </div>
          <span className="status-badge">Dalam antrean</span>
        </div>
        <p className="muted-copy">
          Permohonan Anda sedang ditinjau tim kami. Anda dapat membuat draf kompetisi sekarang,
          tetapi belum bisa mempublikasikannya sampai disetujui sebagai Rekruter Terpercaya.
        </p>
        {submission.vouchedAt ? (
          <p className="muted-copy">
            Anda terhubung dengan institusi terpercaya — permohonan Anda diprioritaskan.
          </p>
        ) : null}
        {documents.length > 0 ? (
          <p className="muted-copy">Dokumen terlampir: {documents.length}</p>
        ) : null}
        <div className="form-field">
          <label className="form-label" htmlFor="rv-document">
            Lampirkan bukti afiliasi (opsional)
          </label>
          <input
            id="rv-document"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            onChange={handleFileSelect}
            className="form-input"
          />
          <p className="form-hint">
            PDF, JPG, PNG, atau WebP (maks. 10 MB). Melampirkan dokumen dapat mempercepat
            peninjauan.
          </p>
        </div>
        <Button
          type="button"
          disabled={!selectedFile}
          loading={uploadBusy}
          onClick={uploadDocument}
        >
          Unggah dokumen
        </Button>
      </section>
    );
  }

  const rejected = submission?.status === "rejected";

  return (
    <section className="content-section recruiter-tier-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Kredibilitas penyelenggara</p>
          <h2>{rejected ? "Ajukan ulang verifikasi" : "Jadi Rekruter Terpercaya"}</h2>
        </div>
        {rejected ? <span className="status-badge">Ditolak</span> : null}
      </div>

      {rejected && submission?.rejectionReason ? (
        <p className="feedback" data-tone="error">
          Alasan penolakan: {submission.rejectionReason}
        </p>
      ) : null}

      <p className="muted-copy">
        Lengkapi data penyelenggara untuk mengajukan verifikasi. Setelah disetujui, Anda dapat
        mempublikasikan kompetisi.
      </p>

      <form onSubmit={submitForm} className="auth-form">
        <div className="form-field">
          <label className="form-label form-label-required" htmlFor="rv-full-name">
            Nama lengkap
          </label>
          <input
            id="rv-full-name"
            type="text"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            className="form-input"
            placeholder="Nama lengkap sesuai identitas"
          />
        </div>

        <div className="form-field">
          <label className="form-label form-label-required" htmlFor="rv-mobile">
            Nomor ponsel
          </label>
          <input
            id="rv-mobile"
            type="tel"
            value={mobileNumber}
            onChange={(event) => setMobileNumber(event.target.value)}
            className="form-input"
            placeholder="Contoh: 0812xxxxxxx"
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="rv-corporate-email">
            Email korporat / institusi (opsional)
          </label>
          <input
            id="rv-corporate-email"
            type="email"
            value={corporateEmail}
            onChange={(event) => setCorporateEmail(event.target.value)}
            className="form-input"
            placeholder="nama@perusahaan.co.id"
          />
          <p className="form-hint">Email domain korporat mempercepat antrean peninjauan Anda.</p>
        </div>

        <Button type="submit" loading={busy}>
          Kirim untuk ditinjau
        </Button>
      </form>
    </section>
  );
}
