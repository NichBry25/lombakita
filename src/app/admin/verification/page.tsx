"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal, useToast } from "@/components/ui/primitives";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { DOCUMENT_TYPE_LABELS } from "@/server/institution-verification/verification-requirements";
import type { InstitutionType } from "@/server/db/schema";
import { formatDisplayToken } from "@/lib/text/capitalize";

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
  campus_organization: "Organisasi kampus",
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
  // Which decision is in flight, so the spinner lands on the button the reviewer pressed.
  const [pendingDecision, setPendingDecision] = useState<"approved" | "rejected" | null>(null);
  const { addToast } = useToast();

  const submitDecision = async (decision: "approved" | "rejected") => {
    setPendingDecision(decision);
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
      setPendingDecision(null);
    }
  };

  return (
    <div className="stack-md admin-review-panel">
      <p className="muted-copy">
        <strong>{detail.institutionDisplayName}</strong> →{" "}
        {TYPE_LABELS[detail.targetInstitutionType]}
        {detail.proposedDisplayName && (
          <span className="admin-proposed-name">
            Nama: &ldquo;{detail.proposedDisplayName}&rdquo;
          </span>
        )}
      </p>

      <div className="stack-sm">
        <p className="form-label">Dokumen</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tipe</th>
                <th>Nama file</th>
                <th>Format</th>
              </tr>
            </thead>
            <tbody>
              {detail.documents.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    {DOCUMENT_TYPE_LABELS[doc.documentType] ?? formatDisplayToken(doc.documentType)}
                  </td>
                  <td>{doc.originalFileName}</td>
                  <td className="data-text">{doc.contentType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="reviewer-notes-textarea" className="form-label">
          Catatan reviewer (Opsional)
        </label>
        <textarea
          id="reviewer-notes-textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="form-textarea"
          placeholder="Catatan untuk pemilik institusi..."
        />
      </div>

      <div className="modal-actions">
        <Button variant="outline" onClick={() => closeModal()} disabled={pendingDecision !== null}>
          Batal
        </Button>
        <Button
          variant="danger"
          onClick={() => void submitDecision("rejected")}
          loading={pendingDecision === "rejected"}
          disabled={pendingDecision !== null}
        >
          Tolak
        </Button>
        <Button
          onClick={() => void submitDecision("approved")}
          loading={pendingDecision === "approved"}
          disabled={pendingDecision !== null}
        >
          Setujui
        </Button>
      </div>
    </div>
  );
}

export default function AdminVerificationPage() {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingReviewId, setOpeningReviewId] = useState<string | null>(null);
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
    setOpeningReviewId(submissionId);
    try {
      const res = await fetch(`/api/platform-ops/verification/submissions/${submissionId}`);
      if (!res.ok) {
        addToast({ type: "error", message: "Gagal memuat detail pengajuan." });
        return;
      }
      const data = (await res.json()) as { submission: SubmissionDetail };
      openModal({
        title: "Tinjau pengajuan",
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
    } finally {
      setOpeningReviewId(null);
    }
  };

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Antrean verifikasi dokumen"
        description="Tinjau bukti institusi yang masih menunggu keputusan Platform Operations."
        actions={<span className="status-badge data-text">{items.length} menunggu</span>}
      />

      {loading && (
        <div className="content-section stack-sm" aria-label="Memuat antrean verifikasi">
          <Skeleton variant="media" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          icon="check"
          title="Antrean sudah bersih."
          description="Tidak ada pengajuan dokumen yang menunggu tinjauan."
        />
      )}

      {!loading && items.length > 0 && (
        <div className="table-scroll">
          <table className="data-table admin-verification-table">
            <thead>
              <tr>
                <th>Institusi</th>
                <th>Submitter</th>
                <th>Tipe tujuan</th>
                <th>Nama diusulkan</th>
                <th>Domain email</th>
                <th>Dokumen</th>
                <th>Dikirim</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.institutionDisplayName}</strong>
                    <br />
                    <span className="record-meta data-text">{item.institutionSlug}</span>
                  </td>
                  <td>{item.submitterEmail ?? "–"}</td>
                  <td>{TYPE_LABELS[item.targetInstitutionType]}</td>
                  <td>{item.proposedDisplayName ?? "–"}</td>
                  <td>
                    {item.emailDomainFlag === null ? (
                      <span className="status-badge">N/A</span>
                    ) : item.emailDomainFlag ? (
                      <span className="status-badge" data-status="open">
                        Institusional
                      </span>
                    ) : (
                      <span className="status-badge" data-status="closing">
                        Personal
                      </span>
                    )}
                  </td>
                  <td className="data-text">{item.documentCount}</td>
                  <td className="data-text">
                    {new Date(item.submittedAt).toLocaleDateString("id-ID")}
                  </td>
                  <td>
                    <Button
                      onClick={() => void openReview(item.id)}
                      loading={openingReviewId === item.id}
                      size="sm"
                    >
                      Tinjau
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
