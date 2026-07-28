"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal, useToast } from "@/components/ui/primitives";
import { Button, EmptyState, Feedback, Icon, PageHeader, Skeleton } from "@/components/ui";

type PendingDocument = { id: string; originalFileName: string; contentType: string };

type PendingItem = {
  submission: {
    id: string;
    status: "pending_review" | "rejected";
    fullName: string;
    mobileNumber: string;
    corporateEmail: string | null;
    emailDomainFlag: boolean | null;
    vouchedAt: string | null;
    rejectionReason: string | null;
    resubmissionAllowed: boolean;
    resubmissionCount: number;
    submittedAt: string;
  };
  submitter: { email: string | null; username: string | null; name: string | null };
  hasDocuments: boolean;
  documents: PendingDocument[];
};

// Priority label reflects the ordering the server applied (vouched → corporate email →
// documents → oldest). Shown to the reviewer as context — the decision is always theirs.
function priorityLabel(item: PendingItem): string {
  if (item.submission.vouchedAt) return "Vouched";
  if (item.submission.emailDomainFlag) return "Email Korporat";
  if (item.hasDocuments) return "Dokumentasi";
  return "Standar";
}

// Distinguishes a first application from one the recruiter reopened after a rejection, so the
// reviewer knows they are looking at a second (or later) attempt before they read the evidence.
function attemptLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "Pengajuan ulang" : `Pengajuan ulang ke-${count}`;
}

export default function RecruiterVerificationQueuePage() {
  const { openModal, closeModal } = useModal();
  const { addToast } = useToast();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  // Each queue row owns several controls; the key keeps the spinner on the pressed one.
  const [pendingAction, setPendingAction] = useState<string | null>(null);

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
      allowResubmission: boolean = true,
    ) => {
      setPendingAction(`review:${submissionId}`);
      try {
        const response = await fetch(
          `/api/platform-ops/recruiter-verification/submissions/${submissionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision, rejectionReason, allowResubmission }),
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
      } finally {
        setPendingAction(null);
      }
    },
    [addToast, closeModal, reload],
  );

  // Opens a document via a freshly minted presigned URL — `inline` views it in a new tab,
  // `attachment` downloads it as `<username>_verification_<original name>`. The presigned URL is
  // short-lived and only ever handed to platform_ops.
  const openDocument = useCallback(
    async (documentId: string, disposition: "inline" | "attachment") => {
      setPendingAction(`document:${documentId}:${disposition}`);
      try {
        const response = await fetch(
          `/api/platform-ops/recruiter-verification/documents/${documentId}?disposition=${disposition}`,
        );
        if (!response.ok) {
          addToast({ type: "error", message: "Gagal membuka dokumen." });
          return;
        }
        const { url } = (await response.json()) as { url: string };
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        addToast({ type: "error", message: "Gagal membuka dokumen karena gangguan koneksi." });
      } finally {
        setPendingAction(null);
      }
    },
    [addToast],
  );

  // Flips whether a rejected applicant may reopen their submission. Used to lift a bar set at
  // rejection time, or to impose one after the fact.
  const setResubmissionAllowed = useCallback(
    async (submissionId: string, allowed: boolean) => {
      setPendingAction(`resubmission:${submissionId}`);
      try {
        const response = await fetch(
          `/api/platform-ops/recruiter-verification/submissions/${submissionId}/resubmission`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ allowed }),
          },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          addToast({ type: "error", message: payload?.error?.message ?? "Perubahan gagal." });
          return;
        }
        addToast({
          type: "success",
          message: allowed
            ? "Pemohon dapat mengajukan ulang."
            : "Pemohon tidak dapat mengajukan ulang.",
        });
        void reload();
      } catch {
        addToast({ type: "error", message: "Perubahan gagal karena gangguan koneksi." });
      } finally {
        setPendingAction(null);
      }
    },
    [addToast, reload],
  );

  // The modal body is static JSX, so both fields are read from closure variables rather than
  // component state — the body never re-renders and nothing here needs to.
  const confirmReject = (item: PendingItem) => {
    let reason = "";
    let allowResubmission = true;
    openModal({
      title: "Tolak permohonan",
      body: (
        <>
          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="reject-reason">
              Alasan penolakan
            </label>
            <input
              id="reject-reason"
              type="text"
              className="form-input"
              required
              aria-describedby="reject-reason-help"
              onChange={(event) => {
                reason = event.target.value;
              }}
              placeholder="Alasan yang akan ditampilkan ke pemohon"
            />
            <p className="form-help" id="reject-reason-help">
              Pemohon akan membaca alasan ini di dasbor mereka.
            </p>
          </div>
          <div className="form-field">
            <label className="checkbox-field" htmlFor="reject-allow-resubmission">
              <input
                id="reject-allow-resubmission"
                type="checkbox"
                defaultChecked
                aria-describedby="reject-allow-resubmission-help"
                onChange={(event) => {
                  allowResubmission = event.target.checked;
                }}
              />
              Izinkan pemohon mengajukan ulang
            </label>
            <p className="form-help" id="reject-allow-resubmission-help">
              Jika dimatikan, pemohon tidak dapat mengirim permohonan baru. Anda masih dapat
              membukanya kembali dari antrean ini.
            </p>
          </div>
        </>
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
            void review(item.submission.id, "reject", reason.trim(), allowResubmission);
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
        title="Verifikasi rekruter"
        description="Antrean permohonan Rekruter Terpercaya, diurutkan berdasarkan prioritas."
      />

      {items.length === 0 ? (
        <EmptyState title="Antrean kosong" description="Tidak ada permohonan yang menunggu." />
      ) : (
        <ul className="stack-md">
          {items.map((item) => {
            const isRejected = item.submission.status === "rejected";
            const attempt = attemptLabel(item.submission.resubmissionCount);
            return (
              <li key={item.submission.id} className="content-section">
                <div className="section-heading">
                  <div>
                    <h2>{item.submission.fullName}</h2>
                    <p className="muted-copy">
                      {item.submitter.username ? `@${item.submitter.username} · ` : ""}
                      {item.submitter.email ?? "email tidak tersedia"}
                    </p>
                  </div>
                  <span className="status-badge" data-status={isRejected ? "closed" : "open"}>
                    {isRejected ? "Ditolak" : priorityLabel(item)}
                  </span>
                </div>
                {attempt ? <p className="muted-copy">{attempt}</p> : null}
                {isRejected ? (
                  <Feedback tone="warning">
                    <p>
                      <strong>Alasan penolakan:</strong>{" "}
                      {item.submission.rejectionReason ?? "Tidak dicatat"}
                    </p>
                    <p>
                      {item.submission.resubmissionAllowed
                        ? "Pemohon dapat merevisi dokumen dan mengajukan ulang."
                        : "Pemohon tidak dapat mengajukan ulang."}
                    </p>
                  </Feedback>
                ) : null}
                <dl className="detail-grid">
                  <div>
                    <dt>Nomor ponsel</dt>
                    <dd>{item.submission.mobileNumber}</dd>
                  </div>
                  <div>
                    <dt>Email korporat</dt>
                    <dd>{item.submission.corporateEmail ?? "—"}</dd>
                  </div>
                </dl>
                {item.documents.length > 0 ? (
                  <ul className="stack-sm">
                    {item.documents.map((document) => (
                      <li key={document.id} className="section-heading">
                        <span className="muted-copy">{document.originalFileName}</span>
                        <div className="auth-form-actions">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            leadingIcon={<Icon name="eye" size="sm" />}
                            loading={pendingAction === `document:${document.id}:inline`}
                            onClick={() => void openDocument(document.id, "inline")}
                          >
                            Lihat
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            leadingIcon={<Icon name="download" size="sm" />}
                            loading={pendingAction === `document:${document.id}:attachment`}
                            onClick={() => void openDocument(document.id, "attachment")}
                          >
                            Unduh
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {/* A rejected submission has no verdict left to give — the recruiter owns it until
                  they reopen it. The only lever the reviewer keeps is the resubmission bar. */}
                <div className="auth-form-actions">
                  {isRejected ? (
                    <Button
                      type="button"
                      variant={item.submission.resubmissionAllowed ? "ghost" : "outline"}
                      size="sm"
                      loading={pendingAction === `resubmission:${item.submission.id}`}
                      onClick={() =>
                        void setResubmissionAllowed(
                          item.submission.id,
                          !item.submission.resubmissionAllowed,
                        )
                      }
                    >
                      {item.submission.resubmissionAllowed
                        ? "Larang ajukan ulang"
                        : "Izinkan ajukan ulang"}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => confirmReject(item)}
                      >
                        Tolak
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        loading={pendingAction === `review:${item.submission.id}`}
                        onClick={() => void review(item.submission.id, "approve", null)}
                      >
                        Setujui
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
