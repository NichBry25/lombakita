"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  EmptyState,
  Feedback,
  FormError,
  FormField,
  FormInput,
  FormLabel,
  FormTextarea,
  FormTextareaWithLimit,
  PageHeader,
  Pagination,
  SelectField,
  Skeleton,
  Table,
  TableClamp,
  TableExpandToggle,
  focusFirstInvalidField,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import {
  resolveVerificationRefusalMessage,
  VERIFICATION_REFUSAL_COPY,
} from "@/lib/institutions/verification-refusal-copy";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "@/lib/institutions/verification-status-labels";

type VerificationStatus = "pending_verification" | "under_review" | "verified" | "rejected";

type TickPath = "domain" | "instagram" | "documents" | "staff";

const REJECT_FALLBACK = "Institusi gagal ditolak. Coba lagi.";
const REVOKE_FALLBACK = "Verifikasi gagal dicabut. Coba lagi.";
const TRANSITION_FALLBACK = "Status verifikasi gagal diubah. Coba lagi.";
const RENAME_FALLBACK = "Nama gagal diubah. Coba lagi.";
const RENAME_SUCCESS_MESSAGE = "Perubahan disimpan.";

// The identity route's own refusals. The server modules that raise them load the database client,
// and this is a client component.
const RENAME_REFUSAL_COPY: Partial<Record<string, string>> = {
  institution_rename_reason_required: VERIFICATION_REFUSAL_COPY.verification_reason_required,
  institution_invalid_payload: VERIFICATION_REFUSAL_COPY.invalid_payload,
  institution_invalid_value: "Periksa nama dan alamat lalu coba lagi.",
  institution_slug_reserved: "Alamat ini tidak dapat digunakan. Pilih alamat lain.",
  institution_display_name_reserved: "Nama ini tidak dapat digunakan. Pilih nama lain.",
  institution_slug_conflicts_with_username:
    "Alamat ini sudah dipakai sebagai username. Pilih alamat lain.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
};

const TICK_PATH_LABELS: Record<TickPath, string> = {
  domain: "Email organisasi",
  instagram: "Instagram",
  documents: "Dokumen",
  staff: "Keputusan staf",
};

// The identity route caps a reason at 1000 characters.
const RENAME_REASON_MAX_LENGTH = 1000;

type AuditEntry = {
  id: string;
  actorUserId: string | null;
  fromStatus: VerificationStatus;
  toStatus: VerificationStatus;
  reason: string | null;
  createdAt: string;
};

type InstitutionRow = {
  id: string;
  displayName: string;
  slug: string;
  verificationStatus: VerificationStatus;
  tickPath: TickPath | null;
  verifiedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  adminEmail: string | null;
  auditLog?: AuditEntry[];
  auditExpanded?: boolean;
};

type ListResponse = {
  institutions: InstitutionRow[];
  total: number;
  page: number;
};

type ValidTransition = { label: string; targetStatus: VerificationStatus; needsReason?: boolean };

const AVAILABLE_TRANSITIONS: Record<VerificationStatus, ValidTransition[]> = {
  pending_verification: [
    { label: "Tinjau", targetStatus: "under_review" },
    { label: "Tolak", targetStatus: "rejected", needsReason: true },
  ],
  under_review: [
    { label: "Verifikasi", targetStatus: "verified" },
    { label: "Tolak", targetStatus: "rejected", needsReason: true },
  ],
  // Revoking returns the institution to 'rejected' rather than to a status of its own: the audit
  // trail already tells a revocation (verified→rejected) apart from a denial (under_review→rejected),
  // and landing on 'rejected' is what re-opens the owner's ability to submit fresh documents.
  verified: [{ label: "Cabut verifikasi", targetStatus: "rejected", needsReason: true }],
  rejected: [{ label: "Tinjau ulang", targetStatus: "under_review" }],
};

const INSTITUTION_COLUMNS: readonly TableColumn[] = [
  { key: "name", header: "Nama", kind: "name" },
  { key: "adminEmail", header: "Admin email", kind: "text" },
  { key: "status", header: "Status", kind: "long" },
  { key: "tickPath", header: "Jalur centang", kind: "text" },
  { key: "createdAt", header: "Terdaftar", kind: "date" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
  { key: "audit", header: "Riwayat status", kind: "control", hideHeader: true },
];

const STATUS_HISTORY_COLUMNS: readonly TableColumn[] = [
  { key: "from", header: "Dari", kind: "text" },
  { key: "to", header: "Ke", kind: "text" },
  { key: "reason", header: "Alasan", kind: "wrap" },
  { key: "actor", header: "Aktor", kind: "text" },
  { key: "at", header: "Waktu", kind: "date" },
];

const verificationStatusTone = (status: VerificationStatus): string | undefined => {
  if (status === "verified") return "open";
  if (status === "rejected") return "closing";
  if (status === "pending_verification") return "awaiting";
  return undefined;
};

// The verification status history of one institution, oldest first, flat inside the band of its row.
function StatusHistory({
  institutionName,
  entries,
}: {
  institutionName: string;
  entries: AuditEntry[];
}) {
  if (entries.length === 0) {
    return <em className="record-meta">Belum ada log audit.</em>;
  }

  const historyRows: TableRowData[] = entries.map((entry) => ({
    key: entry.id,
    cells: {
      from: INSTITUTION_VERIFICATION_STATUS_LABELS[entry.fromStatus],
      to: INSTITUTION_VERIFICATION_STATUS_LABELS[entry.toStatus],
      reason: entry.reason,
      actor: entry.actorUserId,
      at: <LocalDate value={entry.createdAt} format="shortDateTime" />,
    },
  }));

  return (
    <Table
      flat
      label={`Riwayat status ${institutionName}`}
      columns={STATUS_HISTORY_COLUMNS}
      rows={historyRows}
    />
  );
}

const REJECT_INSTITUTION_FORM_ID = "reject-institution-form";

// The pop-up footer submits this form. An empty reason shows the field error and sends nothing.
function RejectInstitutionForm({
  institutionId,
  displayName,
  isRevocation,
  onSuccess,
}: {
  institutionId: string;
  displayName: string;
  // A revocation takes a badge away that was already granted, so it says so plainly and names what
  // it does not do — ops should not reach for it expecting a takedown.
  isRevocation: boolean;
  onSuccess: () => void;
}) {
  const runModalTask = useModalTask();
  const [reason, setReason] = useState("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedReason = reason.trim();
  const reasonMissingMessage = isRevocation
    ? "Alasan pencabutan wajib diisi."
    : "Alasan penolakan wajib diisi.";
  const showsReasonError = hasTriedToSubmit && trimmedReason.length === 0;

  const sendRejection = async (): Promise<ModalOutcome> => {
    try {
      const res = await fetch(`/api/admin/institutions/${institutionId}/verify`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStatus: "rejected", reason: trimmedReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        const fallback = isRevocation ? REVOKE_FALLBACK : REJECT_FALLBACK;
        return { ok: false, message: resolveVerificationRefusalMessage(data?.error, fallback) };
      }

      onSuccess();
      return { ok: true };
    } catch {
      return { ok: false, message: "Terjadi kesalahan jaringan." };
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (trimmedReason.length === 0) return;
    void runModalTask(sendRejection);
  };

  return (
    <form id={REJECT_INSTITUTION_FORM_ID} noValidate onSubmit={submit} className="stack-md">
      <p className="muted-copy">
        <strong>{displayName}</strong>
      </p>
      {isRevocation && (
        <Feedback tone="warning">
          <p>
            Institusi ini akan kehilangan status terverifikasi, dan pemiliknya dapat mengajukan
            dokumen baru. Kompetisi yang sudah terbit tidak ikut dicabut. Gunakan penangguhan jika
            institusi ini harus dihentikan operasinya.
          </p>
        </Feedback>
      )}
      <div className="form-field">
        <FormLabel htmlFor="reject-reason-textarea" required>
          {isRevocation ? "Alasan pencabutan" : "Alasan penolakan"}
        </FormLabel>
        <FormTextarea
          id="reject-reason-textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          aria-invalid={showsReasonError ? true : undefined}
          aria-describedby={showsReasonError ? "reject-reason-error" : undefined}
          placeholder={
            isRevocation ? "Masukkan alasan pencabutan..." : "Masukkan alasan penolakan..."
          }
        />
        {showsReasonError ? (
          <FormError id="reject-reason-error">{reasonMissingMessage}</FormError>
        ) : null}
      </div>
    </form>
  );
}

const RENAME_INSTITUTION_FORM_ID = "rename-institution-form";

// The pop-up footer submits this form. A blank reason shows the field error and sends nothing,
// and the identity route answers every other refusal.
function RenameInstitutionForm({
  institutionId,
  initialDisplayName,
  initialSlug,
  onSuccess,
}: {
  institutionId: string;
  initialDisplayName: string;
  initialSlug: string;
  onSuccess: () => void;
}) {
  const { addToast } = useToast();
  const runModalTask = useModalTask();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [slug, setSlug] = useState(initialSlug);
  const [reason, setReason] = useState("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedReason = reason.trim();
  const showsReasonError = hasTriedToSubmit && trimmedReason.length === 0;
  // A refused submit moves focus to the field it marks, after the render that marks it.
  const formRef = useRef<HTMLFormElement>(null);
  const [errorFocusRequest, setErrorFocusRequest] = useState(0);
  useEffect(() => {
    if (errorFocusRequest === 0) return;
    focusFirstInvalidField(formRef.current);
  }, [errorFocusRequest]);

  const sendRename = async (): Promise<ModalOutcome> => {
    try {
      const res = await fetch(`/api/platform-ops/institutions/${institutionId}/identity`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, slug, reason: trimmedReason }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const fallbackMessage = resolveVerificationRefusalMessage(payload?.error, RENAME_FALLBACK);
        return {
          ok: false,
          message: errorMessageFor(payload?.error?.code, RENAME_REFUSAL_COPY, fallbackMessage),
        };
      }
      addToast({ type: "success", message: RENAME_SUCCESS_MESSAGE });
      onSuccess();
      return { ok: true };
    } catch {
      return { ok: false, message: NETWORK_ERROR_MESSAGE };
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (trimmedReason.length === 0) {
      setErrorFocusRequest((request) => request + 1);
      return;
    }
    void runModalTask(sendRename);
  };

  return (
    <form
      id={RENAME_INSTITUTION_FORM_ID}
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="stack-md"
    >
      <FormField>
        <FormLabel htmlFor="rename-display-name" required>
          Nama
        </FormLabel>
        <FormInput
          id="rename-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor="rename-slug" required>
          Alamat
        </FormLabel>
        <FormInput
          id="rename-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor="rename-reason" required>
          Alasan
        </FormLabel>
        <FormTextareaWithLimit
          id="rename-reason"
          value={reason}
          maxLength={RENAME_REASON_MAX_LENGTH}
          rows={3}
          error={
            showsReasonError ? VERIFICATION_REFUSAL_COPY.verification_reason_required : undefined
          }
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
    </form>
  );
}

export default function AdminInstitutionsPage() {
  const { openModal } = useModal();
  const { addToast } = useToast();
  const [rows, setRows] = useState<InstitutionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // Rows each carry their own controls, so the key records which row-action is running.
  const [pendingRowAction, setPendingRowAction] = useState<string | null>(null);

  const fetchInstitutions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/institutions?${params}`);
      if (res.status === 403) {
        addToast({
          type: "error",
          message: "Akses ditolak. Halaman ini hanya untuk tim Platform Operations.",
        });
        return;
      }
      if (!res.ok) {
        addToast({ type: "error", message: "Gagal memuat data institusi." });
        return;
      }
      const data: ListResponse = await res.json();
      setRows(data.institutions.map((r) => ({ ...r, auditExpanded: false })));
      setTotal(data.total);
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan saat memuat data." });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, addToast]);

  useEffect(() => {
    void fetchInstitutions();
  }, [fetchInstitutions]);

  const performTransition = async (
    institutionId: string,
    targetStatus: VerificationStatus,
    reason?: string,
  ) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/institutions/${institutionId}/verify`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStatus, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          ok: false as const,
          message: resolveVerificationRefusalMessage(data?.error, TRANSITION_FALLBACK),
        };
      }
      return { ok: true as const };
    } catch {
      return { ok: false as const, message: NETWORK_ERROR_MESSAGE };
    } finally {
      setActionLoading(false);
    }
  };

  const handleTransition = async (institutionId: string, targetStatus: VerificationStatus) => {
    setPendingRowAction(`transition:${institutionId}:${targetStatus}`);
    const result = await performTransition(institutionId, targetStatus);
    setPendingRowAction(null);
    if (!result.ok) {
      addToast({ type: "error", message: result.message });
      return;
    }
    await fetchInstitutions();
  };

  const openRejectModal = (id: string, displayName: string, currentStatus: VerificationStatus) => {
    // Both actions PATCH to 'rejected' with a reason; only the institution's current status says
    // whether this is a first denial or the withdrawal of a badge already granted.
    const isRevocation = currentStatus === "verified";
    const mainLabel = isRevocation ? "Cabut verifikasi" : "Tolak institusi";
    openModal({
      title: mainLabel,
      wide: true,
      formId: REJECT_INSTITUTION_FORM_ID,
      body: (
        <RejectInstitutionForm
          institutionId={id}
          displayName={displayName}
          isRevocation={isRevocation}
          onSuccess={() => void fetchInstitutions()}
        />
      ),
      actions: [{ label: "Batal" }, { label: mainLabel, variant: "primary" }],
    });
  };

  const openRenameModal = (row: InstitutionRow) => {
    openModal({
      title: "Ubah nama",
      wide: true,
      formId: RENAME_INSTITUTION_FORM_ID,
      body: (
        <RenameInstitutionForm
          institutionId={row.id}
          initialDisplayName={row.displayName}
          initialSlug={row.slug}
          onSuccess={() => void fetchInstitutions()}
        />
      ),
      actions: [{ label: "Batal" }, { label: "Simpan", variant: "primary" }],
    });
  };

  const updateRow = (rowId: string, patch: Partial<InstitutionRow>) => {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  };

  // Deliberate: a history that cannot be read opens as an empty one, not as an error.
  const fetchAuditEntries = async (institutionId: string): Promise<AuditEntry[]> => {
    try {
      const auditRes = await fetch(`/api/admin/institutions/${institutionId}/audit`);
      if (!auditRes.ok) return [];
      const auditData: { entries: AuditEntry[] } = await auditRes.json();
      return auditData.entries;
    } catch {
      return [];
    }
  };

  const openAudit = async (rowId: string) => {
    setPendingRowAction(`audit:${rowId}`);
    const entries = await fetchAuditEntries(rowId);
    updateRow(rowId, { auditExpanded: true, auditLog: entries });
    setPendingRowAction(null);
  };

  const onAuditOpenChange = (rowId: string, isOpen: boolean) => {
    if (isOpen) {
      void openAudit(rowId);
      return;
    }
    updateRow(rowId, { auditExpanded: false });
  };

  const buildInstitutionRow = (row: InstitutionRow): TableRowData => {
    const transitions = AVAILABLE_TRANSITIONS[row.verificationStatus] ?? [];

    return {
      key: row.id,
      open: row.auditExpanded === true,
      onOpenChange: (isOpen) => onAuditOpenChange(row.id, isOpen),
      cells: {
        name: (
          <>
            {row.displayName}
            <span className="ui-table-sub data-text">{row.slug}</span>
          </>
        ),
        adminEmail: row.adminEmail,
        status: (
          <>
            <span
              className="status-badge"
              data-status={verificationStatusTone(row.verificationStatus)}
            >
              {INSTITUTION_VERIFICATION_STATUS_LABELS[row.verificationStatus]}
            </span>
            {row.rejectionReason ? (
              <div className="admin-rejection-reason">
                <TableClamp>{row.rejectionReason}</TableClamp>
              </div>
            ) : null}
          </>
        ),
        tickPath: row.tickPath === null ? null : TICK_PATH_LABELS[row.tickPath],
        createdAt: <LocalDate value={row.createdAt} format="shortDate" />,
        actions: (
          <div className="table-actions">
            {transitions.map((t) => (
              <Button
                key={t.targetStatus}
                variant={t.targetStatus === "rejected" ? "outline" : "primary"}
                size="sm"
                loading={pendingRowAction === `transition:${row.id}:${t.targetStatus}`}
                disabled={actionLoading}
                onClick={() => {
                  if (t.needsReason) {
                    openRejectModal(row.id, row.displayName, row.verificationStatus);
                  } else {
                    void handleTransition(row.id, t.targetStatus);
                  }
                }}
              >
                {t.label}
              </Button>
            ))}
            <Button variant="outline" size="sm" onClick={() => openRenameModal(row)}>
              Ubah nama
            </Button>
          </div>
        ),
        audit: (
          <TableExpandToggle loading={pendingRowAction === `audit:${row.id}`}>
            Lihat log
          </TableExpandToggle>
        ),
      },
      band: <StatusHistory institutionName={row.displayName} entries={row.auditLog ?? []} />,
    };
  };

  const institutionRows = rows.map(buildInstitutionRow);

  const totalPages = Math.ceil(total / 20);

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Verifikasi institusi"
        description="Kelola transisi status dan jejak audit institusi terdaftar."
        titleMark={
          total > 0 ? <span className="status-badge data-text">{total} institusi</span> : null
        }
      />

      {/* Filter */}
      <div className="admin-filter-toolbar glass-chrome">
        <FormLabel htmlFor="institution-status-filter">Filter</FormLabel>
        <SelectField
          id="institution-status-filter"
          label="Filter"
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
          options={[
            { value: "", label: "Semua Institusi" },
            { value: "pending_verification", label: "Menunggu Verifikasi" },
            { value: "under_review", label: "Sedang Ditinjau" },
            { value: "verified", label: "Terverifikasi Admin" },
            { value: "rejected", label: "Ditolak Admin" },
          ]}
        />
      </div>

      {loading && (
        <div className="content-section stack-sm" aria-label="Memuat institusi">
          <Skeleton variant="media" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      )}

      {!loading && rows.length === 0 && statusFilter === "" && (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada institusi"
          description="Institusi yang mendaftar akan muncul di sini."
        />
      )}

      {!loading && rows.length === 0 && statusFilter !== "" && (
        <EmptyState
          kind="no-match"
          title="Belum ada institusi yang cocok"
          description="Ubah filter status untuk melihat kelompok institusi lainnya."
          action={{
            label: "Bersihkan filter",
            onSelect: () => {
              setStatusFilter("");
              setPage(1);
            },
          }}
        />
      )}

      {!loading && rows.length > 0 && (
        <Table label="Institusi" columns={INSTITUTION_COLUMNS} rows={institutionRows} stacked />
      )}

      {/* Pagination */}
      <Pagination
        page={page}
        totalPages={totalPages}
        label="Halaman institusi"
        onPageChange={setPage}
      />
    </main>
  );
}
