"use client";

import React, { useCallback, useEffect, useState } from "react";

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

const STATUS_COLORS: Record<VerificationStatus, string> = {
  pending_verification: "#856404",
  under_review: "#004085",
  verified: "#155724",
  rejected: "#721c24",
};

const STATUS_BG: Record<VerificationStatus, string> = {
  pending_verification: "#fff3cd",
  under_review: "#cce5ff",
  verified: "#d4edda",
  rejected: "#f8d7da",
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

export default function AdminInstitutionsPage() {
  const [rows, setRows] = useState<InstitutionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rejectModal, setRejectModal] = useState<{
    institutionId: string;
    displayName: string;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchInstitutions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/institutions?${params}`);
      if (res.status === 403) {
        setError("Akses ditolak. Halaman ini hanya untuk platform_ops.");
        return;
      }
      if (!res.ok) {
        setError("Gagal memuat data institusi.");
        return;
      }
      const data: ListResponse = await res.json();
      setRows(data.institutions.map((r) => ({ ...r, auditExpanded: false })));
      setTotal(data.total);
    } catch {
      setError("Terjadi kesalahan saat memuat data.");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

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
      alert(`Gagal: ${result.message}`);
      return;
    }
    await fetchInstitutions();
  };

  const openRejectModal = (id: string, displayName: string) => {
    setRejectModal({ institutionId: id, displayName });
    setRejectReason("");
    setRejectError(null);
  };

  const submitReject = async () => {
    if (!rejectModal) return;
    if (!rejectReason.trim()) {
      setRejectError("Alasan penolakan wajib diisi.");
      return;
    }
    const result = await performTransition(
      rejectModal.institutionId,
      "rejected",
      rejectReason.trim(),
    );
    if (!result.ok) {
      setRejectError(result.message ?? "Gagal menolak institusi.");
      return;
    }
    setRejectModal(null);
    await fetchInstitutions();
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
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: 960,
        margin: "32px auto",
        padding: "0 16px",
        color: "#0f1012",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Verifikasi Institusi</h1>
      <p style={{ color: "#555", marginBottom: 20, fontSize: 14 }}>Platform Ops — Total: {total}</p>

      {/* Filter */}
      <div style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <label htmlFor="institution-status-filter" style={{ fontSize: 13, color: "#444" }}>Filter status:</label>
        <select
          id="institution-status-filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #ccc", fontSize: 13 }}
        >
          <option value="">Semua</option>
          <option value="pending_verification">Menunggu Verifikasi</option>
          <option value="under_review">Sedang Ditinjau</option>
          <option value="verified">Terverifikasi</option>
          <option value="rejected">Ditolak</option>
        </select>
      </div>

      {error && (
        <div
          style={{
            background: "#f8d7da",
            color: "#721c24",
            padding: "10px 14px",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {loading && <p style={{ color: "#555", fontSize: 13 }}>Memuat...</p>}

      {!loading && rows.length === 0 && !error && (
        <p style={{ color: "#555", fontSize: 13 }}>Tidak ada institusi ditemukan.</p>
      )}

      {!loading && rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f2f7fb", textAlign: "left" }}>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Nama</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Admin Email</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Status</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Terdaftar</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Aksi</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #ddd" }}>Audit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const transitions = AVAILABLE_TRANSITIONS[row.verificationStatus] ?? [];
              return (
                <React.Fragment key={row.id}>
                  <tr style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "8px 10px" }}>
                      <strong>{row.displayName}</strong>
                      <br />
                      <span style={{ color: "#888", fontSize: 11 }}>{row.slug}</span>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {row.adminEmail ?? <em style={{ color: "#aaa" }}>–</em>}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span
                        style={{
                          background: STATUS_BG[row.verificationStatus],
                          color: STATUS_COLORS[row.verificationStatus],
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {STATUS_LABELS[row.verificationStatus]}
                      </span>
                      {row.rejectionReason && (
                        <div style={{ color: "#721c24", fontSize: 11, marginTop: 4 }}>
                          {row.rejectionReason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px", color: "#555" }}>
                      {new Date(row.createdAt).toLocaleDateString("id-ID")}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {transitions.length === 0 ? (
                        <em style={{ color: "#aaa", fontSize: 12 }}>–</em>
                      ) : (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {transitions.map((t) => (
                            <button
                              key={t.targetStatus}
                              disabled={actionLoading}
                              onClick={() => {
                                if (t.needsReason) {
                                  openRejectModal(row.id, row.displayName);
                                } else {
                                  void handleTransition(row.id, t.targetStatus);
                                }
                              }}
                              style={{
                                padding: "4px 10px",
                                borderRadius: 6,
                                border: "1px solid #355795",
                                background: t.targetStatus === "rejected" ? "#fff" : "#355795",
                                color: t.targetStatus === "rejected" ? "#355795" : "#f4f8ff",
                                cursor: actionLoading ? "not-allowed" : "pointer",
                                fontSize: 12,
                              }}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <button
                        onClick={() => void toggleAudit(row.id, row.id)}
                        style={{
                          fontSize: 12,
                          background: "none",
                          border: "none",
                          color: "#355795",
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        {row.auditExpanded ? "Sembunyikan" : "Lihat Log"}
                      </button>
                    </td>
                  </tr>
                  {row.auditExpanded && (
                    <tr>
                      <td colSpan={6} style={{ padding: "8px 16px 12px", background: "#f8f9fb" }}>
                        {!row.auditLog || row.auditLog.length === 0 ? (
                          <em style={{ color: "#888", fontSize: 12 }}>Belum ada log audit.</em>
                        ) : (
                          <table
                            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
                          >
                            <thead>
                              <tr style={{ color: "#555" }}>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Dari</th>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Ke</th>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Alasan</th>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Aktor</th>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Waktu</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.auditLog.map((entry) => (
                                <tr key={entry.id} style={{ borderTop: "1px solid #e8e8e8" }}>
                                  <td style={{ padding: "4px 8px" }}>
                                    {STATUS_LABELS[entry.fromStatus]}
                                  </td>
                                  <td style={{ padding: "4px 8px" }}>
                                    {STATUS_LABELS[entry.toStatus]}
                                  </td>
                                  <td style={{ padding: "4px 8px" }}>{entry.reason ?? "–"}</td>
                                  <td style={{ padding: "4px 8px", color: "#888" }}>
                                    {entry.actorUserId ?? "–"}
                                  </td>
                                  <td style={{ padding: "4px 8px", color: "#888" }}>
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
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid #ccc",
              cursor: page <= 1 ? "not-allowed" : "pointer",
            }}
          >
            &larr; Sebelumnya
          </button>
          <span style={{ fontSize: 13, padding: "4px 0" }}>
            Halaman {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid #ccc",
              cursor: page >= totalPages ? "not-allowed" : "pointer",
            }}
          >
            Berikutnya &rarr;
          </button>
        </div>
      )}

      {/* Reject Modal */}
      {rejectModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 10,
              padding: 24,
              width: 400,
              maxWidth: "90vw",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Tolak Institusi</h3>
            <p style={{ color: "#555", fontSize: 13, margin: "0 0 14px" }}>
              <strong>{rejectModal.displayName}</strong>
            </p>
            <label htmlFor="reject-reason-textarea" style={{ fontSize: 13, color: "#333", display: "block", marginBottom: 6 }}>
              Alasan penolakan <span style={{ color: "#d00" }}>*</span>
            </label>
            <textarea
              id="reject-reason-textarea"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
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
              placeholder="Masukkan alasan penolakan..."
            />
            {rejectError && (
              <p style={{ color: "#d00", fontSize: 12, margin: "4px 0 0" }}>{rejectError}</p>
            )}
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setRejectModal(null)}
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
                disabled={actionLoading}
                onClick={() => void submitReject()}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "none",
                  background: "#355795",
                  color: "#fff",
                  cursor: actionLoading ? "not-allowed" : "pointer",
                  fontSize: 13,
                }}
              >
                {actionLoading ? "Memproses..." : "Tolak Institusi"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
