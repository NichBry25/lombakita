"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal, useToast } from "@/components/ui/primitives";
import { DOCUMENT_TYPE_LABELS } from "@/server/institution-verification/verification-requirements";
import type { InstitutionType } from "@/server/db/schema";

type SubmissionStatus = "pending_review" | "approved" | "rejected";

type PendingItem = {
  id: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  submitterEmail: string | null;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  emailDomainFlag: boolean | null;
  submittedAt: string;
  documentCount: number;
};

type DocumentRecord = {
  id: string;
  documentType: string;
  r2Key: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

type SubmissionDetail = {
  id: string;
  institutionSlug: string;
  institutionDisplayName: string;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: SubmissionStatus;
  emailDomainFlag: boolean | null;
  reviewerNotes: string | null;
  submittedAt: string;
  documents: DocumentRecord[];
};

const TYPE_LABELS: Record<InstitutionType, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi Kampus",
};

function ReviewPanelBody({
  detail,
  closeModal,
  onReviewed,
}: {
  detail: SubmissionDetail;
  closeModal: () => void;
  onReviewed: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const submitDecision = async (decision: "approved" | "rejected") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-ops/verification/submissions/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewerNotes: notes.trim() || null }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        addToast({ type: "error", message: data.error?.message ?? `Error ${res.status}` });
        return;
      }
      closeModal();
      onReviewed();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan saat memproses keputusan." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p style={{ color: "#555", fontSize: 13, marginBottom: 16 }}>
        <strong>{detail.institutionDisplayName}</strong> → {TYPE_LABELS[detail.targetInstitutionType]}
        {detail.proposedDisplayName && (
          <span style={{ marginLeft: 8, color: "#355795" }}>
            Nama: &ldquo;{detail.proposedDisplayName}&rdquo;
          </span>
        )}
      </p>

      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "#444", marginBottom: 8, fontWeight: 600 }}>Dokumen:</p>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f2f7fb" }}>
              <th style={{ padding: "4px 8px", textAlign: "left" }}>Tipe</th>
              <th style={{ padding: "4px 8px", textAlign: "left" }}>Nama File</th>
              <th style={{ padding: "4px 8px", textAlign: "left" }}>Format</th>
            </tr>
          </thead>
          <tbody>
            {detail.documents.map((doc) => (
              <tr key={doc.id} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "4px 8px" }}>
                  {DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                </td>
                <td style={{ padding: "4px 8px", color: "#555" }}>{doc.originalFileName}</td>
                <td style={{ padding: "4px 8px", color: "#555" }}>{doc.contentType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label
          htmlFor="reviewer-notes-textarea"
          style={{ fontSize: 13, color: "#333", display: "block", marginBottom: 4 }}
        >
          Catatan Reviewer (opsional)
        </label>
        <textarea
          id="reviewer-notes-textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid #ccc",
            fontSize: 13,
            resize: "vertical",
          }}
          placeholder="Catatan untuk pemilik institusi..."
        />
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button
          onClick={() => closeModal()}
          disabled={loading}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "1px solid #ccc",
            background: "#fff",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Batal
        </button>
        <button
          onClick={() => void submitDecision("rejected")}
          disabled={loading}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "1px solid #721c24",
            background: "#fff",
            color: "#721c24",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          {loading ? "Memproses..." : "Tolak"}
        </button>
        <button
          onClick={() => void submitDecision("approved")}
          disabled={loading}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "none",
            background: loading ? "#aaa" : "#155724",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          {loading ? "Memproses..." : "Setujui"}
        </button>
      </div>
    </div>
  );
}

export default function AdminVerificationPage() {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-ops/verification/pending");
      if (!res.ok) {
        addToast({ type: "error", message: "Gagal memuat antrean verifikasi." });
        return;
      }
      const data = (await res.json()) as { submissions: PendingItem[] };
      setItems(data.submissions);
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan." });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const openReview = async (submissionId: string) => {
    try {
      const res = await fetch(`/api/platform-ops/verification/submissions/${submissionId}`);
      if (!res.ok) {
        addToast({ type: "error", message: "Gagal memuat detail pengajuan." });
        return;
      }
      const data = (await res.json()) as { submission: SubmissionDetail };
      openModal({
        title: "Tinjau Pengajuan",
        body: (
          <ReviewPanelBody
            detail={data.submission}
            closeModal={closeModal}
            onReviewed={() => void fetchPending()}
          />
        ),
        actions: [],
        closeable: true,
      });
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan saat memuat detail." });
    }
  };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", maxWidth: 960, margin: "32px auto", padding: "0 16px", color: "#0f1012" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Antrian Verifikasi Dokumen</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 24 }}>Platform Ops — pengajuan menunggu tinjauan</p>

      {loading && <p style={{ color: "#888", fontSize: 13 }}>Memuat...</p>}

      {!loading && items.length === 0 && (
        <p style={{ color: "#888", fontSize: 13 }}>Tidak ada pengajuan yang menunggu tinjauan.</p>
      )}

      {!loading && items.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f2f7fb", textAlign: "left" }}>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Institusi</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Submitter</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Tipe Tujuan</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Nama Diusulkan</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Domain Email</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Dokumen</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Dikirim</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "8px 10px" }}>
                  <strong>{item.institutionDisplayName}</strong>
                  <br />
                  <span style={{ color: "#888", fontSize: 11 }}>{item.institutionSlug}</span>
                </td>
                <td style={{ padding: "8px 10px", color: "#555" }}>{item.submitterEmail ?? "–"}</td>
                <td style={{ padding: "8px 10px" }}>{TYPE_LABELS[item.targetInstitutionType]}</td>
                <td style={{ padding: "8px 10px", color: "#555" }}>{item.proposedDisplayName ?? "–"}</td>
                <td style={{ padding: "8px 10px" }}>
                  {item.emailDomainFlag === null ? (
                    <em style={{ color: "#aaa" }}>N/A</em>
                  ) : item.emailDomainFlag ? (
                    <span style={{ color: "#155724" }}>Institusional</span>
                  ) : (
                    <span style={{ color: "#856404" }}>Personal</span>
                  )}
                </td>
                <td style={{ padding: "8px 10px", color: "#555" }}>{item.documentCount}</td>
                <td style={{ padding: "8px 10px", color: "#555" }}>
                  {new Date(item.submittedAt).toLocaleDateString("id-ID")}
                </td>
                <td style={{ padding: "8px 10px" }}>
                  <button
                    onClick={() => void openReview(item.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #355795",
                      background: "#355795",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Tinjau
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
