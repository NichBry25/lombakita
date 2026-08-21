"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, EmptyState, Feedback, FormField, FormLabel, FormTextarea } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { asSentence, formatFinanceDateTime, formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";
import { formatFileSize } from "@/lib/text/format-file-size";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";

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
 * un-verified here — reversing it writes a compensating ledger event, which is a platform_ops
 * correction — and a rejected one is reopened by the candidate submitting again, not by the
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

  const refusalMessage = async (response: Response, fallback: string): Promise<string> => {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return payload?.error?.message ?? fallback;
  };

  const openProofFile = async (proofId: string) => {
    setPendingAction(`view:${proofId}`);
    try {
      const response = await fetch(`${base}/${proofId}/view`, { method: "POST" });

      if (!response.ok) {
        addToast({
          type: "error",
          message: await refusalMessage(response, "Bukti transfer tidak dapat dibuka."),
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
        addToast({
          type: "error",
          message: await refusalMessage(response, "Keputusan gagal disimpan."),
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
    openModal({
      title: "Verifikasi bukti transfer?",
      body: (
        <p>
          {`Anda menyatakan telah menerima ${formatRupiah(proof.grossAmount, proof.currency)} dari ` +
            `${proof.payerDisplayName}. Keputusan ini tidak dapat Anda batalkan sendiri — koreksi ` +
            `hanya dapat dilakukan oleh tim Lombakita.`}
        </p>
      ),
      actions: [
        { label: "Batal", variant: "secondary", onClick: () => undefined },
        {
          label: "Verifikasi",
          variant: "primary",
          onClick: () => void sendVerdict(proof.proofId, { action: "verify" }, "Pembayaran diverifikasi."),
        },
      ],
    });
  };

  const openRejectForm = (proof: OrganiserProofView) => {
    // No modal `actions` here. The reject decision carries a reason and a resubmission choice that
    // live in form state, and a modal action closes over the config captured at open time — it
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
                  <p className="eyebrow">Bukti transfer</p>
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
                    <time dateTime={proof.submittedAt}>
                      {formatFinanceDateTime(proof.submittedAt)}
                    </time>
                  </dd>
                </div>
                {proof.dueAt ? (
                  <div>
                    <dt>Batas waktu</dt>
                    <dd>
                      <time dateTime={proof.dueAt}>{formatFinanceDateTime(proof.dueAt)}</time>
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
                <Feedback tone="warning">
                  {`${proof.priorAttempts} bukti sebelumnya sudah ditinjau untuk pembayaran ini.`}
                </Feedback>
              ) : null}

              {proof.status === "rejected" && proof.rejectionReason ? (
                <Feedback tone="info">
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
                    <Button type="button" size="sm" loading={deciding} onClick={() => confirmVerify(proof)}>
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

      <label className="checkbox-field" htmlFor={barredId}>
        <input
          id={barredId}
          type="checkbox"
          checked={barred}
          onChange={(event) => setBarred(event.target.checked)}
        />{" "}
        Peserta tidak boleh mengirim bukti baru
      </label>

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
