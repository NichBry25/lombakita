"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import {
  Button,
  Card,
  CheckboxField,
  EmptyState,
  Feedback,
  FormError,
  FormInput,
  FormLabel,
  Icon,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";

type SurfaceCopy = Partial<Record<string, string>>;

const RECRUITER_VERIFICATION_ERROR_COPY: SurfaceCopy = {
  invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  recruiter_verification_not_found: "Pengajuan tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  operator_actor_is_target: "Anda tidak dapat melakukan tindakan ini pada akun Anda sendiri.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
};

// The same already-reviewed code means a different thing on the review and on the resubmission
// switch, so each action holds its own sentence for it.
const REVIEW_ERROR_COPY: SurfaceCopy = {
  ...RECRUITER_VERIFICATION_ERROR_COPY,
  recruiter_verification_invalid_value: "Isi alasan penolakan.",
  recruiter_verification_already_reviewed:
    "Pengajuan ini sudah ditinjau. Muat ulang halaman untuk melihat hasilnya.",
};

const RESUBMISSION_ERROR_COPY: SurfaceCopy = {
  ...RECRUITER_VERIFICATION_ERROR_COPY,
  recruiter_verification_already_reviewed:
    "Izin pengajuan ulang hanya dapat diubah pada pengajuan yang ditolak. Muat ulang halaman untuk melihat status terbaru.",
};

const REVIEW_FALLBACK: Record<"approve" | "reject", string> = {
  approve: "Pengajuan gagal disetujui. Coba lagi.",
  reject: "Pengajuan gagal ditolak. Coba lagi.",
};

const RESUBMISSION_FALLBACK = "Izin pengajuan ulang gagal diubah. Coba lagi.";

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
// documents → oldest). Shown to the reviewer as context. The decision is always theirs.
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

const REJECT_APPLICATION_FORM_ID = "reject-recruiter-application-form";

const REJECT_REASON_MISSING_MESSAGE = "Isi alasan penolakan.";

// The pop-up footer submits this form. An empty reason shows the field error and sends nothing.
function RejectApplicationForm({
  onSubmit,
}: {
  onSubmit: (reason: string, allowResubmission: boolean) => Promise<ModalOutcome>;
}) {
  const runModalTask = useModalTask();
  const [reason, setReason] = useState("");
  const [allowResubmission, setAllowResubmission] = useState(true);
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedReason = reason.trim();
  const showsReasonError = hasTriedToSubmit && trimmedReason.length === 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (trimmedReason.length === 0) return;
    void runModalTask(() => onSubmit(trimmedReason, allowResubmission));
  };

  return (
    <form id={REJECT_APPLICATION_FORM_ID} noValidate onSubmit={submit} className="stack-md">
      <div className="form-field">
        <FormLabel htmlFor="reject-reason" required>
          Alasan penolakan
        </FormLabel>
        <FormInput
          id="reject-reason"
          type="text"
          value={reason}
          aria-invalid={showsReasonError ? true : undefined}
          aria-describedby={
            showsReasonError ? "reject-reason-error reject-reason-help" : "reject-reason-help"
          }
          onChange={(event) => setReason(event.target.value)}
          placeholder="Alasan yang akan ditampilkan ke pemohon"
        />
        {showsReasonError ? (
          <FormError id="reject-reason-error">{REJECT_REASON_MISSING_MESSAGE}</FormError>
        ) : null}
        <p className="form-help" id="reject-reason-help">
          Pemohon akan membaca alasan ini di dasbor mereka.
        </p>
      </div>
      <div className="form-field">
        <CheckboxField
          id="reject-allow-resubmission"
          checked={allowResubmission}
          aria-describedby="reject-allow-resubmission-help"
          onChange={(event) => setAllowResubmission(event.target.checked)}
        >
          Izinkan pemohon mengajukan ulang
        </CheckboxField>
        <p className="form-help" id="reject-allow-resubmission-help">
          Jika dimatikan, pemohon tidak dapat mengirim permohonan baru. Anda masih dapat membukanya
          kembali dari antrean ini.
        </p>
      </div>
    </form>
  );
}

export default function RecruiterVerificationQueuePage() {
  const { openModal } = useModal();
  const { addToast } = useToast();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  // Each queue row owns several controls; the key keeps the spinner on the pressed one.
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Fetches the pending queue and returns the list (or [] on any failure, with a toast). Pure
  // fetch with no setState, so it is safe to await from both the mount effect and post-review.
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

  // Reports an outcome and toasts only the success, so the reject pop-up can show the failure
  // itself and the approve button can toast it.
  const requestReview = useCallback(
    async (
      submissionId: string,
      decision: "approve" | "reject",
      rejectionReason: string | null,
      allowResubmission: boolean = true,
    ): Promise<ModalOutcome> => {
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
            error?: { code?: string };
          } | null;
          return {
            ok: false,
            message: errorMessageFor(
              payload?.error?.code,
              REVIEW_ERROR_COPY,
              REVIEW_FALLBACK[decision],
            ),
          };
        }
        addToast({
          type: "success",
          message: decision === "approve" ? "Disetujui sebagai Rekruter Terpercaya." : "Ditolak.",
        });
        void reload();
        return { ok: true };
      } catch {
        return { ok: false, message: NETWORK_ERROR_MESSAGE };
      }
    },
    [addToast, reload],
  );

  const review = useCallback(
    async (
      submissionId: string,
      decision: "approve" | "reject",
      rejectionReason: string | null,
    ) => {
      setPendingAction(`review:${submissionId}`);
      const outcome = await requestReview(submissionId, decision, rejectionReason);
      setPendingAction(null);
      if (!outcome.ok) addToast({ type: "error", message: outcome.message });
    },
    [addToast, requestReview],
  );

  // Opens a document via a freshly minted presigned URL. `inline` views it in a new tab,
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
            error?: { code?: string };
          } | null;
          addToast({
            type: "error",
            message: errorMessageFor(
              payload?.error?.code,
              RESUBMISSION_ERROR_COPY,
              RESUBMISSION_FALLBACK,
            ),
          });
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

  const confirmReject = (item: PendingItem) => {
    openModal({
      title: "Tolak permohonan",
      wide: true,
      formId: REJECT_APPLICATION_FORM_ID,
      body: (
        <RejectApplicationForm
          onSubmit={(reason, allowResubmission) =>
            requestReview(item.submission.id, "reject", reason, allowResubmission)
          }
        />
      ),
      actions: [{ label: "Batal" }, { label: "Tolak", variant: "primary" }],
    });
  };

  if (items === null) {
    return (
      <main className="page-shell app-page admin-page">
        <PageHeader title="Verifikasi rekruter" />
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
        <EmptyState
          kind="queue-clear"
          title="Antrean sudah bersih"
          description="Tidak ada permohonan yang menunggu."
        />
      ) : (
        <ul className="stack-md">
          {items.map((item) => {
            const isRejected = item.submission.status === "rejected";
            const attempt = attemptLabel(item.submission.resubmissionCount);
            return (
              <Card as="li" key={item.submission.id} className="content-section">
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
                            variant="outline"
                            size="sm"
                            leadingIcon={<Icon name="eye" size="sm" />}
                            loading={pendingAction === `document:${document.id}:inline`}
                            onClick={() => void openDocument(document.id, "inline")}
                          >
                            Lihat
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
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
                {/* A rejected submission has no verdict left to give. The recruiter owns it until
                  they reopen it. The only lever the reviewer keeps is the resubmission bar. */}
                <div className="auth-form-actions">
                  {isRejected ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={item.submission.resubmissionAllowed}
                      leadingIcon={
                        item.submission.resubmissionAllowed ? (
                          <Icon name="check" size="sm" aria-hidden="true" />
                        ) : undefined
                      }
                      loading={pendingAction === `resubmission:${item.submission.id}`}
                      onClick={() =>
                        void setResubmissionAllowed(
                          item.submission.id,
                          !item.submission.resubmissionAllowed,
                        )
                      }
                    >
                      Izinkan ajukan ulang
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
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
              </Card>
            );
          })}
        </ul>
      )}
    </main>
  );
}
