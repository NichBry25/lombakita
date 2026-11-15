"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  Card,
  CheckboxField,
  DetailList,
  EmptyState,
  Feedback,
  FormError,
  FormField,
  FormLabel,
  FormTextarea,
  Icon,
  IconButton,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
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
  const { openModal } = useModal();
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

  // Both verdict pop-ups show the waiting and the failure themselves, so this reports an outcome
  // and leaves the toast for the success only.
  const sendVerdict = async (
    proofId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ): Promise<ModalOutcome> => {
    try {
      const response = await fetch(`${base}/${proofId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const code = await readErrorCode(response);
        return {
          ok: false,
          message: errorMessageFor(code, PROOF_ERROR_COPY, REFUSAL_FALLBACK.decision),
        };
      }

      addToast({ type: "success", message: successMessage });
      router.refresh();
      return { ok: true };
    } catch {
      return { ok: false, message: "Keputusan gagal disimpan karena gangguan koneksi." };
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
    //
    // Verifying cannot be undone here, so focus starts on the safe choice and an Enter on open
    // cancels.
    openModal({
      title: "Verifikasi bukti transfer?",
      body: (
        <>
          <p>
            {`Anda menyatakan telah menerima ${formatRupiah(proof.grossAmount, proof.currency)} dari ` +
              `${proof.payerDisplayName}. Pastikan dana sudah terlihat pada mutasi rekening ` +
              `institusi Anda sebelum memverifikasi. Setelah diverifikasi, koreksi hanya dapat ` +
              `dilakukan oleh tim Lombakita.`}
          </p>
          <ButtonLink
            variant="link"
            size="sm"
            href="/syarat-ketentuan#biaya-pendaftaran"
            target="_blank"
            rel="noopener noreferrer"
          >
            Baca ketentuan pembayaran
          </ButtonLink>
        </>
      ),
      initialFocus: "safe",
      actions: [
        { label: "Batal" },
        {
          label: "Verifikasi",
          variant: "primary",
          onClick: () =>
            sendVerdict(proof.proofId, { action: "verify" }, "Pembayaran diverifikasi."),
        },
      ],
    });
  };

  // The reject decision carries a reason and a resubmission choice that live in form state, so the
  // form owns its fields and the footer submits it.
  const openRejectForm = (proof: OrganiserProofView) => {
    openModal({
      title: "Tolak bukti transfer?",
      wide: true,
      formId: rejectFormId(proof.proofId),
      body: <RejectForm proof={proof} onSubmit={sendVerdict} />,
      actions: [{ label: "Batal" }, { label: "Tolak pembayaran", variant: "primary" }],
    });
  };

  if (proofs.length === 0) {
    return (
      <EmptyState
        kind="nothing-yet"
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

        return (
          <li key={proof.proofId}>
            <Card className="stack-md">
              <div className="section-heading">
                <div>
                  <h2>{proof.payerDisplayName}</h2>
                </div>
                <span className="status-badge" data-status={PROOF_STATUS_TONES[proof.status]}>
                  {PROOF_STATUS_LABELS[proof.status]}
                </span>
              </div>

              <DetailList
                rows={[
                  {
                    label: "Jumlah",
                    value: (
                      <span className="data-text">
                        {formatRupiah(proof.grossAmount, proof.currency)}
                      </span>
                    ),
                  },
                  {
                    label: "Dikirim",
                    value: <LocalDate value={proof.submittedAt} format="financeDateTime" />,
                  },
                  ...(proof.dueAt
                    ? [
                        {
                          label: "Batas waktu",
                          value: <LocalDate value={proof.dueAt} format="financeDateTime" />,
                        },
                      ]
                    : []),
                  {
                    label: "Berkas",
                    value: (
                      <>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          leadingIcon={<Icon name="eye" size="sm" />}
                          loading={viewing}
                          onClick={() => void openProofFile(proof.proofId)}
                        >
                          {proof.originalFileName}
                        </Button>{" "}
                        · {formatFileSize(proof.fileSizeBytes)}
                      </>
                    ),
                  },
                ]}
              />

              {proof.priorAttempts > 0 ? (
                <Feedback tone="neutral">
                  {`${proof.priorAttempts} bukti sebelumnya sudah ditinjau untuk pembayaran ini.`}
                </Feedback>
              ) : null}

              {proof.status === "rejected" && proof.rejectionReason ? (
                <Feedback tone="neutral">
                  {asSentence(proof.rejectionReason)}
                  {proof.resubmissionAllowed
                    ? " Peserta masih dapat mengirim bukti baru."
                    : " Peserta tidak dapat mengirim ulang."}
                </Feedback>
              ) : null}

              {reviewable ? (
                <div className="record-actions record-actions-end">
                  <IconButton
                    type="button"
                    icon="close"
                    variant="outline"
                    label="Tolak pembayaran"
                    tooltip="Tolak"
                    onClick={() => openRejectForm(proof)}
                  />
                  <Button type="button" size="sm" onClick={() => confirmVerify(proof)}>
                    Verifikasi
                  </Button>
                </div>
              ) : null}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

const rejectFormId = (proofId: string) => `reject-form-${proofId}`;

/**
 * The rejection reason, and the organiser's decision about whether the candidate may try again.
 *
 * Resubmission defaults to ALLOWED. Barring it strands the payer until platform_ops intervenes, so
 * it is opt-in: a reviewer who simply wants a clearer photograph must not have to notice a checkbox
 * in order to avoid ending someone's registration.
 *
 * The pop-up footer submits this form. An empty reason shows the field error and sends nothing.
 */
function RejectForm({
  proof,
  onSubmit,
}: {
  proof: OrganiserProofView;
  onSubmit: (
    proofId: string,
    body: Record<string, unknown>,
    message: string,
  ) => Promise<ModalOutcome>;
}) {
  const runModalTask = useModalTask();
  const [reason, setReason] = useState("");
  const [barred, setBarred] = useState(false);
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);

  const reasonId = `reject-reason-${proof.proofId}`;
  const reasonErrorId = `reject-reason-error-${proof.proofId}`;
  const barredId = `reject-barred-${proof.proofId}`;
  const trimmedReason = reason.trim();
  const showsReasonError = hasTriedToSubmit && trimmedReason.length === 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (trimmedReason.length === 0) return;
    void runModalTask(() =>
      onSubmit(
        proof.proofId,
        { action: "reject", reason: trimmedReason, resubmissionAllowed: !barred },
        "Bukti transfer ditolak.",
      ),
    );
  };

  return (
    <form id={rejectFormId(proof.proofId)} noValidate onSubmit={submit} className="stack-md">
      <DetailList rows={[{ label: "Peserta", value: proof.payerDisplayName }]} />
      <p>Alasan akan ditampilkan kepada peserta.</p>

      <FormField>
        <FormLabel htmlFor={reasonId} required>
          Alasan penolakan
        </FormLabel>
        <FormTextarea
          id={reasonId}
          value={reason}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Contoh: nominal transfer tidak sesuai dengan biaya pendaftaran."
          aria-invalid={showsReasonError ? true : undefined}
          aria-describedby={showsReasonError ? reasonErrorId : undefined}
        />
        {/* No limit and so no counter, but the row keeps its height for the error. */}
        <div className="form-message-row">
          {showsReasonError ? (
            <FormError id={reasonErrorId}>
              {PROOF_ERROR_COPY.manual_proof_reason_required}
            </FormError>
          ) : null}
        </div>
      </FormField>

      <CheckboxField
        id={barredId}
        checked={barred}
        onChange={(event) => setBarred(event.target.checked)}
      >
        Peserta tidak boleh mengirim bukti baru
      </CheckboxField>
    </form>
  );
}
