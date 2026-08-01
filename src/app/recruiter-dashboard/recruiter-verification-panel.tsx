"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Feedback, Icon, IconButton } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { sessionFetch } from "@/lib/session/session-fetch";
import {
  getFileExtension,
  mimeTypeForExtension,
  preValidateVerificationDocument,
} from "@/lib/recruiter-verification/verification-document";

type SubmissionStatus = "draft" | "pending_review" | "approved" | "rejected";

type Submission = {
  id: string;
  status: SubmissionStatus;
  rejectionReason: string | null;
  resubmissionAllowed: boolean;
  resubmissionCount: number;
  fullName: string;
  mobileNumber: string;
  corporateEmail: string | null;
  vouchedAt: string | null;
};

type DocumentEntry = {
  id: string;
  originalFileName: string;
  fileSizeBytes: number;
  createdAt: string;
};

type PanelProps = {
  userId: string;
  isTrusted: boolean;
  submission: Submission | null;
  documents: DocumentEntry[];
};

function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatUploadedAt(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Recruiter trust status panel. Renders one of six states: Trusted (publishing unlocked), awaiting
// review (frozen — documents read-only, with a withdraw control), withdrawn draft (editable),
// rejected but reopenable (reason, editable documents, prefilled form), rejected and barred from
// reapplying (reason only), or no submission yet (the affiliation form).
// Editing is possible exactly in the states where a reviewer cannot act, so the two sides never
// contend: to change a queued submission the applicant withdraws it first. The rejection reason is
// persistent page content rather than a toast — it is the instruction the applicant works from, so
// it has to survive a reload. Every mutation goes through sessionFetch per the cross-session
// guard.
export function RecruiterVerificationPanel({
  userId,
  isTrusted,
  submission,
  documents,
}: PanelProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  const [busy, setBusy] = useState(false);

  // Prefilled from the last attempt so a recruiter revising after a rejection only changes what
  // the verdict objected to. Empty on a first submission.
  const [fullName, setFullName] = useState(submission?.fullName ?? "");
  const [mobileNumber, setMobileNumber] = useState(submission?.mobileNumber ?? "");
  const [corporateEmail, setCorporateEmail] = useState(submission?.corporateEmail ?? "");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  // Each attached document owns its own delete control, so the id keeps the spinner on the
  // pressed one rather than every row at once.
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const deleteDocument = async (document: DocumentEntry) => {
    setDeletingDocumentId(document.id);
    try {
      const response = await sessionFetch(
        userId,
        `/api/v1/recruiter/me/verification/documents/${document.id}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Dokumen gagal dihapus. Coba lagi.",
        });
        return;
      }

      addToast({ type: "success", message: "Dokumen dihapus." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Dokumen gagal dihapus karena gangguan koneksi." });
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const confirmDeleteDocument = (document: DocumentEntry) => {
    openModal({
      title: "Hapus dokumen",
      body: (
        <p>
          Hapus <strong>{document.originalFileName}</strong> dari permohonan Anda? Berkas ini tidak
          dapat dikembalikan dan peninjau tidak akan melihatnya lagi.
        </p>
      ),
      actions: [
        { label: "Batal", variant: "secondary", onClick: closeModal },
        {
          label: "Hapus",
          variant: "danger",
          onClick: () => void deleteDocument(document),
        },
      ],
    });
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

  const withdrawSubmission = async () => {
    setBusy(true);
    try {
      const response = await sessionFetch(userId, "/api/v1/recruiter/me/verification/withdraw", {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            payload?.error?.message ?? "Permohonan tidak dapat ditarik. Muat ulang halaman ini.",
        });
        return;
      }

      addToast({ type: "success", message: "Permohonan ditarik. Anda dapat memperbaikinya." });
      window.location.reload();
    } catch {
      addToast({ type: "error", message: "Penarikan gagal karena gangguan koneksi." });
    } finally {
      setBusy(false);
    }
  };

  const confirmWithdraw = () => {
    openModal({
      title: "Tarik permohonan",
      body: (
        <p>
          Permohonan Anda akan keluar dari antrean peninjauan sehingga Anda dapat mengubah data dan
          dokumennya. Anda perlu mengirimnya kembali setelah selesai, dan antrean akan dihitung
          ulang dari waktu pengiriman baru.
        </p>
      ),
      actions: [
        { label: "Batal", variant: "secondary", onClick: closeModal },
        {
          label: "Tarik permohonan",
          variant: "danger",
          onClick: () => {
            closeModal();
            void withdrawSubmission();
          },
        },
      ],
    });
  };

  if (isTrusted) {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
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

  // The attached-document list. `editable` adds the per-row delete control; without it the list is
  // a plain record of what the reviewer is looking at.
  const renderDocumentList = (editable: boolean) => {
    if (documents.length === 0) return null;
    return (
      <>
        <h3>Dokumen terlampir ({documents.length})</h3>
        <ul className="record-list">
          {documents.map((document) => (
            <li className="record-row" key={document.id}>
              <div className="record-row-main">
                <p className="record-row-title">{document.originalFileName}</p>
                <span className="record-meta">
                  {formatFileSize(document.fileSizeBytes)} · Diunggah{" "}
                  {formatUploadedAt(document.createdAt)}
                </span>
              </div>
              {editable ? (
                <div className="record-actions">
                  <IconButton
                    label={`Hapus ${document.originalFileName}`}
                    icon="trash"
                    loading={deletingDocumentId === document.id}
                    onClick={() => confirmDeleteDocument(document)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </>
    );
  };

  // Document list plus the upload control. Rendered only in the states where the applicant owns
  // the submission — a withdrawn draft, or a rejected one awaiting a reopen.
  const renderDocumentSection = () => (
    <>
      {renderDocumentList(true)}
      <div className="form-field">
        <label className="form-label" htmlFor="rv-document">
          Lampirkan Bukti Afiliasi (Opsional)
        </label>
        <div className="pf-media-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
          >
            Dokumen
          </Button>
          <span className="form-hint">
            {selectedFile ? selectedFile.name : "Belum ada berkas yang dipilih"}
          </span>
        </div>
        <input
          id="rv-document"
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
          onChange={handleFileSelect}
          className="sr-only"
        />
        <p className="form-hint">
          PDF, JPG, PNG, atau WebP (maks. 10 MB). Melampirkan dokumen yang jelas dapat mempercepat
          peninjauan.
        </p>
      </div>
      <Button type="button" disabled={!selectedFile} loading={uploadBusy} onClick={uploadDocument}>
        Unggah dokumen
      </Button>
    </>
  );

  // The affiliation form. Shared by the first-submission and reopen-after-rejection states, which
  // post to the same endpoint and differ only in their submit label.
  const renderAffiliationForm = (submitLabel: string) => (
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
          Email korporat / institusi (Opsional)
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
        {submitLabel}
      </Button>
    </form>
  );

  if (submission?.status === "pending_review") {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <h2>Menunggu peninjauan</h2>
          </div>
          <span className="status-badge">Diproses</span>
        </div>
        <p className="muted-copy">
          Permohonan Anda sedang ditinjau tim kami. Anda dapat membuat draf kompetisi sekarang,
          tetapi belum bisa mempublikasikannya sampai disetujui sebagai Rekruter Terpercaya.
        </p>
        {submission.vouchedAt ? (
          <p className="muted-copy">
            Anda terhubung dengan institusi terpercaya, jadi permohonan Anda diprioritaskan.
          </p>
        ) : null}
        {renderDocumentList(false)}
        <p className="muted-copy">
          Data dan dokumen terkunci selama peninjauan berlangsung, agar peninjau menilai berkas yang
          sama dengan yang Anda kirim. Untuk mengubahnya, tarik permohonan Anda lebih dulu.
        </p>
        <Button type="button" variant="outline" loading={busy} onClick={confirmWithdraw}>
          Tarik permohonan
        </Button>
      </section>
    );
  }

  if (submission?.status === "draft") {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <h2>Lengkapi permohonan</h2>
          </div>
          <span className="status-badge" data-status="closed">
            Ditarik
          </span>
        </div>
        {/* A withdrawn submission is invisible to reviewers and nothing chases the applicant for
            it, so this state has to say plainly that no one is looking at it and that sending it
            back is their move. A muted paragraph is too easy to skim past. */}
        <Feedback tone="warning">
          <p>
            <strong>Permohonan Anda tidak berada dalam antrean peninjauan.</strong> Tidak ada
            peninjau yang sedang memeriksanya, dan status Anda tidak akan berubah sampai Anda
            mengirimnya kembali.
          </p>
        </Feedback>
        <p className="muted-copy">
          Perbarui data dan dokumen Anda, lalu kirim kembali untuk masuk ke antrean peninjauan.
        </p>
        {renderDocumentSection()}
        {renderAffiliationForm("Kirim untuk ditinjau")}
      </section>
    );
  }

  if (submission?.status === "rejected" && !submission.resubmissionAllowed) {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <h2>Permohonan ditolak</h2>
          </div>
          <span className="status-badge" data-status="closed">
            Ditolak
          </span>
        </div>
        <Feedback tone="error">
          <p>
            <strong>Alasan penolakan:</strong> {submission.rejectionReason ?? "Tidak dicatat"}
          </p>
        </Feedback>
        <p className="muted-copy">
          Akun Anda tidak dapat mengirim permohonan verifikasi baru. Hubungi tim dukungan jika Anda
          merasa keputusan ini keliru.
        </p>
      </section>
    );
  }

  if (submission?.status === "rejected") {
    return (
      <section className="content-section recruiter-tier-card">
        <div className="section-heading">
          <div>
            <h2>Perbaiki dan ajukan ulang</h2>
          </div>
          <span className="status-badge" data-status="closed">
            Ditolak
          </span>
        </div>
        <Feedback tone="error">
          <p>
            <strong>Alasan penolakan:</strong> {submission.rejectionReason ?? "Tidak dicatat"}
          </p>
        </Feedback>
        <p className="muted-copy">
          Perbarui data dan dokumen Anda, lalu ajukan ulang. Dokumen yang sudah terlampir tetap
          tersimpan. Hapus yang tidak lagi relevan, lalu unggah penggantinya.
        </p>
        {renderDocumentSection()}
        {renderAffiliationForm("Ajukan ulang untuk ditinjau")}
      </section>
    );
  }

  return (
    <section className="content-section recruiter-tier-card">
      <div className="section-heading">
        <div>
          <h2>Jadi Rekruter Terpercaya</h2>
        </div>
      </div>

      <p className="muted-copy">
        Lengkapi data penyelenggara untuk mengajukan verifikasi. Setelah disetujui, Anda dapat
        mempublikasikan kompetisi.
      </p>

      {renderAffiliationForm("Kirim untuk ditinjau")}
    </section>
  );
}
