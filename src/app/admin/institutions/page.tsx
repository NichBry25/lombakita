"use client";

import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Button,
  EmptyState,
  Feedback,
  FormError,
  FormLabel,
  FormTextarea,
  PageHeader,
  Pagination,
  SelectField,
  Skeleton,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { emailDeliveryWarning } from "@/lib/email/delivery-notice";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { resolveVerificationRefusalMessage } from "@/lib/institutions/verification-refusal-copy";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "@/lib/institutions/verification-status-labels";

type VerificationStatus = "pending_verification" | "under_review" | "verified" | "rejected";

const REJECT_FALLBACK = "Institusi gagal ditolak. Coba lagi.";
const REVOKE_FALLBACK = "Verifikasi gagal dicabut. Coba lagi.";
const TRANSITION_FALLBACK = "Status verifikasi gagal diubah. Coba lagi.";

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
  const { addToast } = useToast();
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

      // The status change is committed either way, so a failed notice is a warning on a success.
      const deliveryWarning = emailDeliveryWarning(data?.emailDelivery);
      if (deliveryWarning) {
        addToast({ type: "error", message: deliveryWarning });
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
      return { ok: true as const, deliveryWarning: emailDeliveryWarning(data?.emailDelivery) };
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
    if (result.deliveryWarning) {
      addToast({ type: "error", message: result.deliveryWarning });
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

  const toggleAudit = async (rowId: string, institutionId: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    setPendingRowAction(`audit:${rowId}`);

    if (row.auditExpanded && row.auditLog) {
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, auditExpanded: false } : r)));
      return;
    }

    try {
      const auditRes = await fetch(`/api/admin/institutions/${institutionId}/audit`);
      if (auditRes.ok) {
        const auditData: { entries: AuditEntry[] } = await auditRes.json();
        setRows((prev) =>
          prev.map((r) =>
            r.id === rowId ? { ...r, auditExpanded: true, auditLog: auditData.entries } : r,
          ),
        );
      } else {
        setRows((prev) =>
          prev.map((r) => (r.id === rowId ? { ...r, auditExpanded: true, auditLog: [] } : r)),
        );
      }
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.id === rowId ? { ...r, auditExpanded: true, auditLog: [] } : r)),
      );
    }
  };

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
        <div className="table-scroll">
          <table className="data-table admin-institutions-table">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Admin email</th>
                <th>Status</th>
                <th>Terdaftar</th>
                <th>Aksi</th>
                <th>Audit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const transitions = AVAILABLE_TRANSITIONS[row.verificationStatus] ?? [];
                return (
                  <React.Fragment key={row.id}>
                    <tr>
                      <td>
                        <strong>{row.displayName}</strong>
                        <br />
                        <span className="record-meta data-text">{row.slug}</span>
                      </td>
                      <td>{row.adminEmail ?? <em>–</em>}</td>
                      <td>
                        <span
                          className="status-badge"
                          data-status={
                            row.verificationStatus === "verified"
                              ? "open"
                              : row.verificationStatus === "rejected"
                                ? "closing"
                                : row.verificationStatus === "pending_verification"
                                  ? "awaiting"
                                  : undefined
                          }
                        >
                          {INSTITUTION_VERIFICATION_STATUS_LABELS[row.verificationStatus]}
                        </span>
                        {row.rejectionReason && (
                          <div className="admin-rejection-reason">{row.rejectionReason}</div>
                        )}
                      </td>
                      <td className="data-text">
                        <LocalDate value={row.createdAt} format="numericDate" />
                      </td>
                      <td>
                        {transitions.length === 0 ? (
                          <em>–</em>
                        ) : (
                          <div className="table-actions">
                            {transitions.map((t) => (
                              <Button
                                key={t.targetStatus}
                                variant={t.targetStatus === "rejected" ? "outline" : "primary"}
                                size="sm"
                                loading={
                                  pendingRowAction === `transition:${row.id}:${t.targetStatus}`
                                }
                                disabled={actionLoading}
                                onClick={() => {
                                  if (t.needsReason) {
                                    openRejectModal(
                                      row.id,
                                      row.displayName,
                                      row.verificationStatus,
                                    );
                                  } else {
                                    void handleTransition(row.id, t.targetStatus);
                                  }
                                }}
                              >
                                {t.label}
                              </Button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={pendingRowAction === `audit:${row.id}`}
                          onClick={() => void toggleAudit(row.id, row.id)}
                        >
                          {row.auditExpanded ? "Sembunyikan" : "Lihat log"}
                        </Button>
                      </td>
                    </tr>
                    {row.auditExpanded && (
                      <tr className="admin-audit-row">
                        <td colSpan={6}>
                          {!row.auditLog || row.auditLog.length === 0 ? (
                            <em className="record-meta">Belum ada log audit.</em>
                          ) : (
                            <table className="data-table admin-audit-table">
                              <thead>
                                <tr>
                                  <th>Dari</th>
                                  <th>Ke</th>
                                  <th>Alasan</th>
                                  <th>Aktor</th>
                                  <th>Waktu</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.auditLog.map((entry) => (
                                  <tr key={entry.id}>
                                    <td>
                                      {INSTITUTION_VERIFICATION_STATUS_LABELS[entry.fromStatus]}
                                    </td>
                                    <td>
                                      {INSTITUTION_VERIFICATION_STATUS_LABELS[entry.toStatus]}
                                    </td>
                                    <td>{entry.reason ?? "–"}</td>
                                    <td className="data-text">{entry.actorUserId ?? "–"}</td>
                                    <td className="data-text">
                                      <LocalDate value={entry.createdAt} format="numericDateTime" />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
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
