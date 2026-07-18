"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useModal, useToast } from "@/components/ui/primitives";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import {
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENTS_BY_TYPE,
} from "@/server/institution-verification/verification-requirements";
import type { InstitutionType } from "@/server/db/schema";

type SubmissionItem = {
  id: string;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: "pending_review" | "approved" | "rejected";
  submittedAt: string;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  documentCount: number;
};

const STATUS_LABELS: Record<SubmissionItem["status"], string> = {
  pending_review: "Menunggu Ditinjau",
  approved: "Disetujui",
  rejected: "Ditolak",
};

const TYPE_LABELS: Record<InstitutionType, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi Kampus",
};

const SELECTABLE_TYPES: InstitutionType[] = [
  "personal",
  "company",
  "foundation",
  "university",
  "campus_organization",
];

type DocField = {
  documentType: string;
  fileName: string;
  file: File | null;
};

export default function InstitutionVerificationPage() {
  const { institutionSlug } = useParams<{ institutionSlug: string }>();
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();

  const [submissions, setSubmissions] = useState<SubmissionItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [targetType, setTargetType] = useState<InstitutionType>("personal");
  const [proposedDisplayName, setProposedDisplayName] = useState("");
  const [docFields, setDocFields] = useState<DocField[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (sessionStatus === "unauthenticated") {
      router.push(`/auth/login?callbackUrl=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [sessionStatus, router]);

  useEffect(() => {
    const requiredDocs = REQUIRED_DOCUMENTS_BY_TYPE[targetType] ?? [];
    setDocFields(
      requiredDocs.map((dt) => ({
        documentType: dt,
        fileName: "",
        file: null,
      })),
    );
  }, [targetType]);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/v1/institutions/${institutionSlug}/verification/submissions`);
      if (res.ok) {
        const data = (await res.json()) as { submissions: SubmissionItem[] };
        setSubmissions(data.submissions);
      }
    } catch {
      // Silently degrade — history not critical to rendering the form
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (sessionStatus === "authenticated") {
      void fetchHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, institutionSlug]);

  const handleSubmit = async () => {
    for (const field of docFields) {
      if (!field.file) {
        openModal({
          title: "Dokumen Belum Lengkap",
          body: `Unggah dokumen ${DOCUMENT_TYPE_LABELS[field.documentType] ?? field.documentType} sebelum melanjutkan.`,
          actions: [{ label: "OK", onClick: () => {} }],
        });
        return;
      }
    }

    if (targetType !== "personal" && !proposedDisplayName.trim()) {
      openModal({
        title: "Nama Institusi Wajib Diisi",
        body: "Masukkan nama institusi yang akan ditampilkan setelah verifikasi.",
        actions: [{ label: "OK", onClick: () => {} }],
      });
      return;
    }

    setSubmitting(true);
    try {
      const documents = docFields.map((f) => ({
        documentType: f.documentType,
        originalFileName: f.file!.name,
        fileSizeBytes: f.file!.size,
        contentType: f.file!.type || "application/octet-stream",
      }));

      const res = await fetch(`/api/v1/institutions/${institutionSlug}/verification/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Expected-User-Id": session?.user?.id ?? "",
        },
        body: JSON.stringify({
          targetType,
          proposedDisplayName: targetType !== "personal" ? proposedDisplayName.trim() : null,
          documents,
        }),
      });

      const data = (await res.json()) as {
        submissionId?: string;
        documents?: Array<{ documentType: string; uploadUrl: string; r2Key: string }>;
        error?: { code: string; message: string; details?: Record<string, unknown> };
      };

      if (!res.ok) {
        const errMsg = data.error?.message ?? `Error ${res.status}`;
        openModal({
          title: "Pengajuan Gagal",
          body: errMsg,
          actions: [{ label: "OK", onClick: () => {} }],
        });
        return;
      }

      // Upload each document file to its presigned R2 URL.
      const uploadErrors: string[] = [];
      for (const uploadTarget of data.documents ?? []) {
        const field = docFields.find((f) => f.documentType === uploadTarget.documentType);
        if (!field?.file) continue;
        try {
          const uploadRes = await fetch(uploadTarget.uploadUrl, {
            method: "PUT",
            body: field.file,
            headers: { "Content-Type": field.file.type || "application/octet-stream" },
          });
          if (!uploadRes.ok) {
            uploadErrors.push(
              DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ?? uploadTarget.documentType,
            );
          }
        } catch {
          uploadErrors.push(
            DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ?? uploadTarget.documentType,
          );
        }
      }

      if (uploadErrors.length > 0) {
        addToast({
          type: "error",
          message: `Pengajuan dibuat, tetapi upload gagal untuk: ${uploadErrors.join(", ")}. Hubungi dukungan.`,
        });
      } else {
        addToast({
          type: "success",
          message: "Dokumen berhasil dikirim. Kami akan meninjau dalam 1–3 hari kerja.",
        });
      }

      setProposedDisplayName("");
      await fetchHistory();
    } finally {
      setSubmitting(false);
    }
  };

  if (sessionStatus === "loading") {
    return (
      <main className="page-shell app-page institution-verification-page">
        <div className="stack-md" aria-label="Memuat halaman verifikasi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell app-page institution-verification-page">
      <PageHeader
        eyebrow="Kredibilitas institusi"
        title="Verifikasi institusi"
        description="Kirim dokumen identitas resmi untuk ditinjau oleh tim platform."
        backHref={`/institution/${institutionSlug}`}
        backLabel="Panel institusi"
      />

      {/* Submission form */}
      <section className="content-section verification-submit-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Pengajuan baru</p>
            <h2>Dokumen verifikasi</h2>
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="institution-target-type" className="form-label">
            Tipe Institusi
          </label>
          <select
            id="institution-target-type"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as InstitutionType)}
            className="form-select"
          >
            {SELECTABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {targetType !== "personal" && (
          <div className="form-field">
            <label htmlFor="institution-proposed-name" className="form-label form-label-required">
              Nama Institusi
            </label>
            <input
              id="institution-proposed-name"
              type="text"
              value={proposedDisplayName}
              onChange={(e) => setProposedDisplayName(e.target.value)}
              placeholder="Nama resmi institusi"
              className="form-input"
            />
          </div>
        )}

        <div className="verification-documents">
          <p className="form-label">Dokumen yang dibutuhkan</p>
          {docFields.map((field, i) => (
            <div key={field.documentType} className="form-field verification-document-field">
              <label
                htmlFor={`doc-${field.documentType}`}
                className="form-label form-label-required"
              >
                {DOCUMENT_TYPE_LABELS[field.documentType] ?? field.documentType}
              </label>
              <input
                id={`doc-${field.documentType}`}
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setDocFields((prev) =>
                    prev.map((f, idx) =>
                      idx === i ? { ...f, file, fileName: file?.name ?? "" } : f,
                    ),
                  );
                }}
                className="form-file"
              />
            </div>
          ))}
        </div>

        <Button disabled={submitting} onClick={() => void handleSubmit()} loading={submitting}>
          {submitting ? "Mengirim..." : "Kirim Dokumen"}
        </Button>
      </section>

      {/* Submission history */}
      <section className="content-section verification-history-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Jejak pengajuan</p>
            <h2>Riwayat verifikasi</h2>
          </div>
          <span className="status-badge data-text">{submissions.length}</span>
        </div>
        {loadingHistory && (
          <div className="stack-sm" aria-label="Memuat riwayat verifikasi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        )}
        {!loadingHistory && submissions.length === 0 && (
          <EmptyState
            icon="check"
            title="Belum ada pengajuan."
            description="Riwayat peninjauan dokumen institusi akan muncul di sini."
          />
        )}
        {!loadingHistory && submissions.length > 0 && (
          <div className="table-scroll">
            <table className="data-table verification-history-table">
              <thead>
                <tr>
                  <th>Tipe tujuan</th>
                  <th>Status</th>
                  <th>Dokumen</th>
                  <th>Dikirim</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td>{TYPE_LABELS[s.targetInstitutionType]}</td>
                    <td>
                      <span
                        className="status-badge"
                        data-status={
                          s.status === "approved"
                            ? "open"
                            : s.status === "rejected"
                              ? "closed"
                              : "closing"
                        }
                      >
                        {STATUS_LABELS[s.status]}
                      </span>
                    </td>
                    <td className="data-text">{s.documentCount}</td>
                    <td className="data-text">
                      {new Date(s.submittedAt).toLocaleDateString("id-ID")}
                    </td>
                    <td>{s.reviewerNotes ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
