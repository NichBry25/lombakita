"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CheckboxField,
  EmptyState,
  Feedback,
  FormField,
  FormLabel,
  FormTextarea,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { asSentence, formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";
import { formatFileSize } from "@/lib/text/format-file-size";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode } from "@/lib/session/session-fetch";

type RefusalAction = "open" | "decision";

const PROOF_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Hanya pemilik atau staf institusi yang dapat meninjau bukti transfer.",
  manual_proof_not_found: "Bukti transfer tidak ditemukan.",
  manual_proof_upload_unavailable:
    "Penyimpanan berkas tidak tersedia, jadi bukti transfer belum dapat dibuka. Coba lagi nanti.",
  manual_proof_action_unrecognised:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  manual_proof_not_pending:
    "Bukti transfer ini tidak sedang menunggu tinjauan, mungkin sudah ditinjau.",
  manual_proof_payment_not_found: "Pembayaran tidak ditemukan.",
  manual_proof_registration_cancelled:
    "Pendaftaran ini sudah dibatalkan, sehingga bukti transfer tidak dapat diproses.",
  manual_proof_lane_closed:
    "Pembayaran ini sudah selesai, sehingga bukti transfer tidak dapat diproses.",
  manual_proof_reason_required:
    "Penolakan harus menyertakan alasan agar peserta tahu apa yang perlu diperbaiki.",
};

const REFUSAL_FALLBACK: Record<RefusalAction, string> = {
  open: "Bukti transfer tidak dapat dibuka. Coba lagi.",
  decision: "Keputusan gagal disimpan. Coba lagi.",
};

export type OrganiserProofView = {
  proofId: string;
  status: ManualPaymentProofStatus;
  submittedAt: string;
  originalFileName: string;
  fileSizeBytes: number;
  grossAmount: number;
  currency: string;
  dueAt: string | null;
  payerDisplayName: string;
  priorAttempts: number;
  rejectionReason: string | null;
  resubmissionAllowed: boolean;
};

type Props = {
  institutionSlug: string;
  competitionId: string;
  proofs: OrganiserProofView[];
};

/**
 * The organiser's bukti transfer review queue.
 *
 * VERDICT CONTROLS ARE WITHHELD on anything not awaiting review. A verified payment cannot be
 * un-verified here, because reversing it writes a compensating ledger event, which is a
 * platform_ops correction. A rejected one is reopened by the candidate submitting again, not by the
 * organiser. Rendering either control disabled would advertise an action this surface does not own
 * and send the reviewer looking for the permission that would enable it.
 */
export function OrganiserPaymentQueue({ institutionSlug, competitionId, proofs }: Props) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  // Keyed by proof id and action, so the spinner sits on the control that was pressed. A shared
  // boolean would spin every row's buttons at once.
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const base = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/payment-proofs`;

  const openProofFile = async (proofId: string) => {
    setPendingAction(`view:${proofId}`);
    try {
      const response = await fetch(`${base}/${proofId}/view`, { method: "POST" });

      if (!response.ok) {
        const code = await readErrorCode(response);
        addToast({
          type: "error",
          message: errorMessageFor(code, PROOF_ERROR_COPY, REFUSAL_FALLBACK.open),
        });
        return;
      }

      const { url } = (await response.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      addToast({ type: "error", message: "Gagal membuka bukti transfer karena gangguan koneksi." });
    } finally {
      setPendingAction(null);
    }
  };

  const sendVerdict = async (
    proofId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) => {
    setPendingAction(`verdict:${proofId}`);
    try {
      const response = await fetch(`${base}/${proofId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const code = await readErrorCode(response);
        addToast({
          type: "error",
          message: errorMessageFor(code, PROOF_ERROR_COPY, REFUSAL_FALLBACK.decision),
        });
        return;
      }

      addToast({ type: "success", message: successMessage });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Keputusan gagal disimpan karena gangguan koneksi." });
    } finally {
      setPendingAction(null);
    }
  };

  const confirmVerify = (proof: OrganiserProofView) => {
    // Confirmed rather than immediate: verifying writes a `succeeded` ledger event and a fee
    // accrual, and the ledger is append-only, so there is no undo on this surface. The dialog names
    // the amount because that figure is what the organiser is asserting they received.
    //
    // The middle sentence is the operational instruction. The page states it once above the queue
    // as context, and the dialog repeats it at the moment the reviewer commits, because the
    // transfer lands in the institution's own account and their bank statement is the only record
    // that can confirm it.
    openModal({
      title: "Verifikasi bukti transfer?",
      body: (
        <p>
          {`Anda menyatakan telah menerima ${formatRupiah(proof.grossAmount, proof.currency)} dari ` +
            `${proof.payerDisplayName}. Pastikan dana sudah terlihat pada mutasi rekening lembaga ` +
            `Anda, karena Lombakita tidak dapat memeriksanya. Keputusan ini tidak dapat Anda ` +
            `batalkan sendiri, koreksi hanya dapat dilakukan oleh tim Lombakita.`}
        </p>
      ),
      actions: [
        { label: "Batal", variant: "secondary", onClick: () => undefined },
        {
          label: "Verifikasi",
          variant: "primary",
          onClick: () =>
            void sendVerdict(proof.proofId, { action: "verify" }, "Pembayaran diverifikasi."),
        },
      ],
    });
  };

  const openRejectForm = (proof: OrganiserProofView) => {
    // No modal `actions` here. The reject decision carries a reason and a resubmission choice that
    // live in form state, and a modal action closes over the config captured at open time, so it
    // would submit the empty reason the form started with.
    openModal({
      title: "Tolak bukti transfer",
      body: <RejectForm proof={proof} onSubmit={sendVerdict} onDone={closeModal} />,
      actions: [],
    });
  };

  if (proofs.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="Belum ada bukti transfer"
        description="Bukti transfer akan muncul di sini setelah peserta mengunggahnya."
      />
    );
  }

  return (
    <ul className="record-list">
      {proofs.map((proof) => {
        const reviewable = proof.status === "pending_review";
        const viewing = pendingAction === `view:${proof.proofId}`;
        const deciding = pendingAction === `verdict:${proof.proofId}`;

        return (
          <li key={proof.proofId}>
            <Card variant="surface" className="stack-md">
              <div className="section-heading">
                <div>
                  <h2>{proof.payerDisplayName}</h2>
                </div>
                <span className="status-badge" data-status={PROOF_STATUS_TONES[proof.status]}>
                  {PROOF_STATUS_LABELS[proof.status]}
                </span>
              </div>

              <dl className="detail-grid">
                <div>
                  <dt>Jumlah</dt>
                  <dd className="data-text">{formatRupiah(proof.grossAmount, proof.currency)}</dd>
                </div>
                <div>
                  <dt>Dikirim</dt>
                  <dd>
                    <LocalDate value={proof.submittedAt} format="financeDateTime" />
                  </dd>
                </div>
                {proof.dueAt ? (
                  <div>
                    <dt>Batas waktu</dt>
                    <dd>
                      <LocalDate value={proof.dueAt} format="financeDateTime" />
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Berkas</dt>
                  <dd>
                    {proof.originalFileName} · {formatFileSize(proof.fileSizeBytes)}
                  </dd>
                </div>
              </dl>

              {proof.priorAttempts > 0 ? (
                <Feedback tone="neutral">
                  {`${proof.priorAttempts} bukti sebelumnya sudah ditinjau untuk pembayaran ini.`}
                </Feedback>
              ) : null}

              {proof.status === "rejected" && proof.rejectionReason ? (
                <Feedback tone="error">
                  {`Ditolak dengan alasan: ${asSentence(proof.rejectionReason)}`}
                  {proof.resubmissionAllowed
                    ? " Peserta masih dapat mengirim bukti baru."
                    : " Peserta tidak dapat mengirim ulang."}
                </Feedback>
              ) : null}

              <div className="record-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={viewing}
                  onClick={() => void openProofFile(proof.proofId)}
                >
                  Lihat bukti
                </Button>

                {reviewable ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      loading={deciding}
                      onClick={() => confirmVerify(proof)}
                    >
                      Verifikasi
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      loading={deciding}
                      onClick={() => openRejectForm(proof)}
                    >
                      Tolak
                    </Button>
                  </>
                ) : null}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The rejection reason, and the organiser's decision about whether the candidate may try again.
 *
 * Resubmission defaults to ALLOWED. Barring it strands the payer until platform_ops intervenes, so
 * it is opt-in: a reviewer who simply wants a clearer photograph must not have to notice a checkbox
 * in order to avoid ending someone's registration.
 */
function RejectForm({
  proof,
  onSubmit,
  onDone,
}: {
  proof: OrganiserProofView;
  onSubmit: (proofId: string, body: Record<string, unknown>, message: string) => Promise<void>;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [barred, setBarred] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reasonId = `reject-reason-${proof.proofId}`;
  const barredId = `reject-barred-${proof.proofId}`;
  const canSubmit = reason.trim().length > 0;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit(
      proof.proofId,
      { action: "reject", reason: reason.trim(), resubmissionAllowed: !barred },
      "Bukti transfer ditolak.",
    );
    setSubmitting(false);
    onDone();
  };

  return (
    <div className="stack-md">
      <p>{`Peserta: ${proof.payerDisplayName}. Alasan akan ditampilkan kepada peserta.`}</p>

      <FormField>
        <FormLabel htmlFor={reasonId}>Alasan penolakan</FormLabel>
        <FormTextarea
          id={reasonId}
          value={reason}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Contoh: nominal transfer tidak sesuai dengan biaya pendaftaran."
        />
      </FormField>

      <CheckboxField
        id={barredId}
        checked={barred}
        onChange={(event) => setBarred(event.target.checked)}
      >
        Peserta tidak boleh mengirim bukti baru
      </CheckboxField>

      <div className="record-actions">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Batal
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          // `disabled` and `loading` are different conditions, so both appear: an empty reason is
          // refused by the server, and a reviewer should not have to discover that by submitting.
          disabled={!canSubmit}
          loading={submitting}
          onClick={() => void submit()}
        >
          Tolak bukti transfer
        </Button>
      </div>
    </div>
  );
}
