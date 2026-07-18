"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";

type VerificationStatus = "pending_verification" | "under_review" | "verified" | "rejected";

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

const STATUS_LABELS: Record<VerificationStatus, string> = {
  pending_verification: "Menunggu Verifikasi",
  under_review: "Sedang Ditinjau",
  verified: "Terverifikasi",
  rejected: "Ditolak",
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
  verified: [],
  rejected: [],
};

function RejectInstitutionForm({
  institutionId,
  displayName,
  onClose,
  onSuccess,
}: {
  institutionId: string;
  displayName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { addToast } = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!reason.trim()) {
      addToast({ type: "error", message: "Alasan penolakan wajib diisi." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/institutions/${institutionId}/verify`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStatus: "rejected", reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({ type: "error", message: data?.error?.message ?? `Error ${res.status}` });
        return;
      }
      onClose();
      onSuccess();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-md">
      <p className="muted-copy">
        <strong>{displayName}</strong>
      </p>
      <div className="form-field">
        <label htmlFor="reject-reason-textarea" className="form-label form-label-required">
          Alasan penolakan
        </label>
        <textarea
          id="reject-reason-textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="form-textarea"
          placeholder="Masukkan alasan penolakan..."
        />
      </div>
      <div className="modal-actions">
        <Button variant="outline" onClick={onClose}>
          Batal
        </Button>
        <Button variant="danger" disabled={busy} loading={busy} onClick={() => void submit()}>
          {busy ? "Memproses..." : "Tolak Institusi"}
        </Button>
      </div>
    </div>
  );
}

export default function AdminInstitutionsPage() {
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const [rows, setRows] = useState<InstitutionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchInstitutions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/institutions?${params}`);
      if (res.status === 403) {
        addToast({
          type: "error",
          message: "Akses ditolak. Halaman ini hanya untuk platform_ops.",
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
        return { ok: false, message: data?.error?.message ?? `Error ${res.status}` };
      }
      return { ok: true };
    } finally {
      setActionLoading(false);
    }
  };

  const handleTransition = async (institutionId: string, targetStatus: VerificationStatus) => {
    const result = await performTransition(institutionId, targetStatus);
    if (!result.ok) {
      addToast({ type: "error", message: `Gagal: ${result.message}` });
      return;
    }
    await fetchInstitutions();
  };

  const openRejectModal = (id: string, displayName: string) => {
    openModal({
      title: "Tolak Institusi",
      body: (
        <RejectInstitutionForm
          institutionId={id}
          displayName={displayName}
          onClose={closeModal}
          onSuccess={() => void fetchInstitutions()}
        />
      ),
      actions: [],
      closeable: true,
    });
  };

  const toggleAudit = async (rowId: string, institutionId: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

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
        eyebrow="Status kelembagaan"
        title="Verifikasi institusi"
        description="Kelola transisi status dan jejak audit institusi terdaftar."
        backHref="/admin"
        backLabel="Panel Platform Ops"
        actions={<span className="status-badge data-text">{total} institusi</span>}
      />

      {/* Filter */}
      <div className="admin-filter-toolbar glass-chrome">
        <label htmlFor="institution-status-filter" className="form-label">
          Filter status
        </label>
        <select
          id="institution-status-filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="form-select"
        >
          <option value="">Semua</option>
          <option value="pending_verification">Menunggu Verifikasi</option>
          <option value="under_review">Sedang Ditinjau</option>
          <option value="verified">Terverifikasi</option>
          <option value="rejected">Ditolak</option>
        </select>
      </div>

      {loading && (
        <div className="content-section stack-sm" aria-label="Memuat institusi">
          <Skeleton variant="media" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <EmptyState
          icon="building"
          title="Tidak ada institusi ditemukan."
          description="Ubah filter status untuk melihat kelompok institusi lainnya."
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
                                ? "closed"
                                : row.verificationStatus === "pending_verification"
                                  ? "closing"
                                  : undefined
                          }
                        >
                          {STATUS_LABELS[row.verificationStatus]}
                        </span>
                        {row.rejectionReason && (
                          <div className="admin-rejection-reason">{row.rejectionReason}</div>
                        )}
                      </td>
                      <td className="data-text">
                        {new Date(row.createdAt).toLocaleDateString("id-ID")}
                      </td>
                      <td>
                        {transitions.length === 0 ? (
                          <em>–</em>
                        ) : (
                          <div className="table-actions">
                            {transitions.map((t) => (
                              <Button
                                key={t.targetStatus}
                                variant={t.targetStatus === "rejected" ? "danger" : "primary"}
                                size="sm"
                                disabled={actionLoading}
                                onClick={() => {
                                  if (t.needsReason) {
                                    openRejectModal(row.id, row.displayName);
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
                          variant="ghost"
                          size="sm"
                          onClick={() => void toggleAudit(row.id, row.id)}
                        >
                          {row.auditExpanded ? "Sembunyikan" : "Lihat Log"}
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
                                    <td>{STATUS_LABELS[entry.fromStatus]}</td>
                                    <td>{STATUS_LABELS[entry.toStatus]}</td>
                                    <td>{entry.reason ?? "–"}</td>
                                    <td className="data-text">{entry.actorUserId ?? "–"}</td>
                                    <td className="data-text">
                                      {new Date(entry.createdAt).toLocaleString("id-ID")}
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
      {totalPages > 1 && (
        <nav className="pagination" aria-label="Halaman institusi">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            &larr; Sebelumnya
          </Button>
          <span className="pagination-status data-text">
            Halaman {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Berikutnya &rarr;
          </Button>
        </nav>
      )}
    </main>
  );
}
