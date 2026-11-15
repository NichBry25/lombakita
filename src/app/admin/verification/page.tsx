"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal, useToast } from "@/components/ui/primitives";
import {
  Button,
  EmptyState,
  FormLabel,
  FormLabelText,
  FormTextarea,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { DOCUMENT_TYPE_LABELS } from "@/server/institution-verification/verification-requirements";
import { INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";
import type { InstitutionType } from "@/server/db/schema";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { emailDeliveryWarning, type EmailDeliveryPayload } from "@/lib/email/delivery-notice";
import { resolveVerificationRefusalMessage } from "@/lib/institutions/verification-refusal-copy";

type SubmissionStatus = "pending_review" | "approved" | "rejected";

const DECISION_FALLBACK: Record<"approved" | "rejected", string> = {
  approved: "Pengajuan gagal disetujui. Coba lagi.",
  rejected: "Pengajuan gagal ditolak. Coba lagi.",
};

const DOCUMENT_COLUMNS: readonly TableColumn[] = [
  { key: "type", header: "Tipe", kind: "name" },
  { key: "fileName", header: "Nama file", kind: "text" },
  { key: "format", header: "Format", kind: "text" },
];

const QUEUE_COLUMNS: readonly TableColumn[] = [
  { key: "institution", header: "Institusi", kind: "name" },
  { key: "submitter", header: "Submitter", kind: "text" },
  { key: "target", header: "Tipe tujuan", kind: "text" },
  { key: "proposedName", header: "Nama diusulkan", kind: "text" },
  { key: "domain", header: "Domain email", kind: "pill" },
  { key: "documents", header: "Dokumen", kind: "number" },
  { key: "submittedAt", header: "Dikirim", kind: "date" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
];

function EmailDomainPill({ flag }: { flag: boolean | null }) {
  if (flag === null) return <span className="status-badge">N/A</span>;
  if (flag) {
    return (
      <span className="status-badge" data-status="open">
        Institusional
      </span>
    );
  }
  return (
    <span className="status-badge" data-status="closed">
      Personal
    </span>
  );
}

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

  const documentRows: TableRowData[] = detail.documents.map((doc) => ({
    key: doc.id,
    cells: {
      type: DOCUMENT_TYPE_LABELS[doc.documentType] ?? formatDisplayToken(doc.documentType),
      fileName: doc.originalFileName,
      format: doc.contentType,
    },
  }));

  const submitDecision = async (decision: "approved" | "rejected") => {
    setPendingDecision(decision);
    try {
      const res = await fetch(`/api/platform-ops/verification/submissions/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewerNotes: notes.trim() || null }),
      });
      const data = (await res.json()) as {
        error?: { code?: string; message?: string };
        emailDelivery?: EmailDeliveryPayload;
      };
      if (!res.ok) {
        addToast({
          type: "error",
          message: resolveVerificationRefusalMessage(data.error, DECISION_FALLBACK[decision]),
        });
        return;
      }

      // The decision is committed either way, so a failed notice is a warning on a success, never
      // an error that would suggest the review did not land.
      const deliveryWarning = emailDeliveryWarning(data.emailDelivery);
      if (deliveryWarning) {
        addToast({ type: "error", message: deliveryWarning });
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
        {INSTITUTION_TYPE_LABELS[detail.targetInstitutionType]}
        {detail.proposedDisplayName && (
          <span className="admin-proposed-name">
            Nama: &ldquo;{detail.proposedDisplayName}&rdquo;
          </span>
        )}
      </p>

      <div className="stack-sm">
        <FormLabelText as="p">Dokumen</FormLabelText>
        <Table label="Dokumen" columns={DOCUMENT_COLUMNS} rows={documentRows} />
      </div>

      <div className="form-field">
        <FormLabel htmlFor="reviewer-notes-textarea" optional>
          Catatan reviewer
        </FormLabel>
        <FormTextarea
          id="reviewer-notes-textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Catatan untuk pemilik institusi..."
        />
      </div>

      <div className="modal-actions">
        <Button variant="outline" onClick={() => closeModal()} disabled={pendingDecision !== null}>
          Batal
        </Button>
        <Button
          variant="primary"
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
        wide: true,
        actions: [],
      });
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan saat memuat detail." });
    } finally {
      setOpeningReviewId(null);
    }
  };

  const queueRows: TableRowData[] = items.map((item) => ({
    key: item.id,
    cells: {
      institution: (
        <>
          {item.institutionDisplayName}
          <span className="ui-table-sub data-text">{item.institutionSlug}</span>
        </>
      ),
      submitter: item.submitterEmail,
      target: INSTITUTION_TYPE_LABELS[item.targetInstitutionType],
      proposedName: item.proposedDisplayName,
      domain: <EmailDomainPill flag={item.emailDomainFlag} />,
      documents: item.documentCount,
      submittedAt: <LocalDate value={item.submittedAt} format="shortDate" />,
      actions: (
        <Button
          onClick={() => void openReview(item.id)}
          loading={openingReviewId === item.id}
          size="sm"
        >
          Tinjau
        </Button>
      ),
    },
  }));

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Antrean verifikasi dokumen"
        description="Tinjau bukti institusi yang masih menunggu keputusan Platform Operations."
        titleMark={
          items.length > 0 ? (
            <span className="status-badge data-text">{items.length} menunggu</span>
          ) : null
        }
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
          kind="queue-clear"
          title="Antrean sudah bersih"
          description="Tidak ada pengajuan dokumen yang menunggu tinjauan."
        />
      )}

      {!loading && items.length > 0 && (
        <Table label="Antrean verifikasi" columns={QUEUE_COLUMNS} rows={queueRows} stacked />
      )}
    </main>
  );
}
