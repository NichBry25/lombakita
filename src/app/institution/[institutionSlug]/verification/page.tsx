"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useModal, useToast } from "@/components/ui/primitives";
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
      const res = await fetch(
        `/api/v1/institutions/${institutionSlug}/verification/submissions`,
      );
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

    if ((targetType !== "personal") && !proposedDisplayName.trim()) {
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

      const res = await fetch(
        `/api/v1/institutions/${institutionSlug}/verification/submit`,
        {
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
        },
      );

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
            uploadErrors.push(DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ?? uploadTarget.documentType);
          }
        } catch {
          uploadErrors.push(DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ?? uploadTarget.documentType);
        }
      }

      if (uploadErrors.length > 0) {
        addToast({
          type: "error",
          message: `Pengajuan dibuat, tetapi upload gagal untuk: ${uploadErrors.join(", ")}. Hubungi dukungan.`,
        });
      } else {
        addToast({ type: "success", message: "Dokumen berhasil dikirim. Kami akan meninjau dalam 1–3 hari kerja." });
      }

      setProposedDisplayName("");
      await fetchHistory();
    } finally {
      setSubmitting(false);
    }
  };

  if (sessionStatus === "loading") return null;

  return (
    <div style={{ fontFamily: "Arial, sans-serif", maxWidth: 680, margin: "32px auto", padding: "0 16px", color: "#0f1012" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Verifikasi Institusi</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 24 }}>
        Kirim dokumen identitas untuk memverifikasi institusi Anda.
      </p>

      {/* Submission form */}
      <div style={{ background: "#f2f7fb", padding: 20, borderRadius: 10, marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 16 }}>Pengajuan Baru</h2>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="institution-target-type" style={{ fontSize: 13, display: "block", marginBottom: 4, color: "#333" }}>
            Tipe Institusi
          </label>
          <select
            id="institution-target-type"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as InstitutionType)}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", fontSize: 13, width: "100%" }}
          >
            {SELECTABLE_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        {targetType !== "personal" && (
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="institution-proposed-name" style={{ fontSize: 13, display: "block", marginBottom: 4, color: "#333" }}>
              Nama Institusi <span style={{ color: "#d00" }}>*</span>
            </label>
            <input
              id="institution-proposed-name"
              type="text"
              value={proposedDisplayName}
              onChange={(e) => setProposedDisplayName(e.target.value)}
              placeholder="Nama resmi institusi"
              style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6, border: "1px solid #ccc", fontSize: 13 }}
            />
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#444", marginBottom: 8 }}>Dokumen yang dibutuhkan:</p>
          {docFields.map((field, i) => (
            <div key={field.documentType} style={{ marginBottom: 10 }}>
              <label htmlFor={`doc-${field.documentType}`} style={{ fontSize: 13, color: "#333", display: "block", marginBottom: 4 }}>
                {DOCUMENT_TYPE_LABELS[field.documentType] ?? field.documentType} <span style={{ color: "#d00" }}>*</span>
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
                style={{ fontSize: 13 }}
              />
            </div>
          ))}
        </div>

        <button
          disabled={submitting}
          onClick={() => void handleSubmit()}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: submitting ? "#aaa" : "#355795",
            color: "#fff",
            cursor: submitting ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {submitting ? "Mengirim..." : "Kirim Dokumen"}
        </button>
      </div>

      {/* Submission history */}
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Riwayat Pengajuan</h2>
      {loadingHistory && <p style={{ color: "#888", fontSize: 13 }}>Memuat riwayat...</p>}
      {!loadingHistory && submissions.length === 0 && (
        <p style={{ color: "#888", fontSize: 13 }}>Belum ada pengajuan.</p>
      )}
      {!loadingHistory && submissions.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f2f7fb", textAlign: "left" }}>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Tipe Tujuan</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Status</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Dokumen</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Dikirim</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Catatan</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "8px 10px" }}>{TYPE_LABELS[s.targetInstitutionType]}</td>
                <td style={{ padding: "8px 10px" }}>
                  <span
                    style={{
                      background:
                        s.status === "approved" ? "#d4edda" : s.status === "rejected" ? "#f8d7da" : "#fff3cd",
                      color:
                        s.status === "approved" ? "#155724" : s.status === "rejected" ? "#721c24" : "#856404",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {STATUS_LABELS[s.status]}
                  </span>
                </td>
                <td style={{ padding: "8px 10px", color: "#555" }}>{s.documentCount}</td>
                <td style={{ padding: "8px 10px", color: "#555" }}>
                  {new Date(s.submittedAt).toLocaleDateString("id-ID")}
                </td>
                <td style={{ padding: "8px 10px", color: "#555", maxWidth: 200, wordBreak: "break-word" }}>
                  {s.reviewerNotes ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
