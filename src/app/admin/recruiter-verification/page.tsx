"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal, useToast } from "@/components/ui/primitives";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";

type PendingItem = {
  submission: {
    id: string;
    fullName: string;
    mobileNumber: string;
    corporateEmail: string | null;
    emailDomainFlag: boolean | null;
    vouchedAt: string | null;
    submittedAt: string;
  };
  submitter: { email: string | null; username: string | null; name: string | null };
  hasDocuments: boolean;
};

// Priority label reflects the ordering the server applied (vouched → corporate email →
// documents → oldest). Shown to the reviewer as context — the decision is always theirs.
function priorityLabel(item: PendingItem): string {
  if (item.submission.vouchedAt) return "Vouched oleh institusi terpercaya";
  if (item.submission.emailDomainFlag) return "Email korporat";
  if (item.hasDocuments) return "Dokumen terlampir";
  return "Standar";
}

export default function RecruiterVerificationQueuePage() {
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const [items, setItems] = useState<PendingItem[] | null>(null);

  // Fetches the pending queue and returns the list (or [] on any failure, with a toast). Pure
  // fetch — no setState — so it is safe to await from both the mount effect and post-review.
  const fetchPending = useCallback(async (): Promise<PendingItem[]> => {
    try {
      const response = await fetch("/api/platform-ops/recruiter-verification/pending");
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat antrean." });
        return [];
      }
      const payload = (await response.json()) as { submissions: PendingItem[] };
      return payload.submissions;
    } catch {
      addToast({ type: "error", message: "Gagal memuat antrean karena gangguan koneksi." });
      return [];
    }
  }, [addToast]);

  const reload = useCallback(async () => {
    setItems(await fetchPending());
  }, [fetchPending]);

  useEffect(() => {
    let active = true;
    void fetchPending().then((list) => {
      if (active) setItems(list);
    });
    return () => {
      active = false;
    };
  }, [fetchPending]);

  const review = useCallback(
    async (
      submissionId: string,
      decision: "approve" | "reject",
      rejectionReason: string | null,
    ) => {
      const response = await fetch(
        `/api/platform-ops/recruiter-verification/submissions/${submissionId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, rejectionReason }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({ type: "error", message: payload?.error?.message ?? "Peninjauan gagal." });
        return;
      }
      addToast({
        type: "success",
        message: decision === "approve" ? "Disetujui sebagai Rekruter Terpercaya." : "Ditolak.",
      });
      closeModal();
      void reload();
    },
    [addToast, closeModal, reload],
  );

  const confirmReject = (item: PendingItem) => {
    let reason = "";
    openModal({
      title: "Tolak permohonan",
      body: (
        <div className="form-field">
          <label className="form-label form-label-required" htmlFor="reject-reason">
            Alasan penolakan
          </label>
          <input
            id="reject-reason"
            type="text"
            className="form-input"
            onChange={(event) => {
              reason = event.target.value;
            }}
            placeholder="Alasan yang akan ditampilkan ke pemohon"
          />
        </div>
      ),
      actions: [
        {
          label: "Batal",
          variant: "secondary",
          onClick: closeModal,
        },
        {
          label: "Tolak",
          variant: "danger",
          onClick: () => {
            if (reason.trim().length === 0) {
              addToast({ type: "error", message: "Isi alasan penolakan." });
              return;
            }
            void review(item.submission.id, "reject", reason.trim());
          },
        },
      ],
    });
  };

  if (items === null) {
    return (
      <main className="page-shell app-page admin-page">
        <PageHeader eyebrow="Operasi platform" title="Verifikasi rekruter" />
        <Skeleton />
      </main>
    );
  }

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        eyebrow="Operasi platform"
        title="Verifikasi rekruter"
        description="Antrean permohonan Rekruter Terpercaya, diurutkan berdasarkan prioritas."
      />

      {items.length === 0 ? (
        <EmptyState title="Antrean kosong" description="Tidak ada permohonan yang menunggu." />
      ) : (
        <ul className="stack-md">
          {items.map((item) => (
            <li key={item.submission.id} className="content-section">
              <div className="section-heading">
                <div>
                  <h2>{item.submission.fullName}</h2>
                  <p className="muted-copy">
                    {item.submitter.username ? `@${item.submitter.username} · ` : ""}
                    {item.submitter.email ?? "email tidak tersedia"}
                  </p>
                </div>
                <span className="status-badge" data-status="open">
                  {priorityLabel(item)}
                </span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Nomor ponsel</dt>
                  <dd>{item.submission.mobileNumber}</dd>
                </div>
                <div>
                  <dt>Email korporat</dt>
                  <dd>{item.submission.corporateEmail ?? "—"}</dd>
                </div>
                <div>
                  <dt>Dokumen</dt>
                  <dd>{item.hasDocuments ? "Terlampir" : "Tidak ada"}</dd>
                </div>
              </dl>
              <div className="auth-form-actions">
                <Button type="button" variant="ghost" size="sm" onClick={() => confirmReject(item)}>
                  Tolak
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void review(item.submission.id, "approve", null)}
                >
                  Setujui sebagai Terpercaya
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
