"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  EmptyState,
  Feedback,
  PageSection,
  FormError,
  FormField,
  FormLabel,
  FormTextarea,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { asSentence, formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import { errorMessageFor } from "@/lib/errors/error-copy";

const OPS_PAYMENT_ERROR_COPY: Partial<Record<string, string>> = {
  ops_reason_required: "Alasan wajib diisi.",
  manual_proof_not_voidable:
    "Bukti transfer ini tidak dapat dibatalkan lagi. Muat ulang halaman untuk melihat status terbaru.",
  operator_actor_is_target: "Anda tidak dapat menangani pembayaran yang Anda lakukan sendiri.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
};

const OPS_REASON_FORM_ID = "ops-reason-form";

const VOID_PROOF_FALLBACK = "Bukti transfer gagal dibatalkan. Coba lagi.";

export type OpsProofView = {
  proofId: string;
  status: ManualPaymentProofStatus;
  submittedAt: string;
  attempt: number;
  grossAmount: number;
  currency: string;
  dueAt: string | null;
  payerDisplayName: string;
  voidable: boolean;
};

export type OpsCompetitionView = {
  competitionId: string;
  title: string;
  institutionSlug: string;
  slug: string;
  status: string;
  proofs: OpsProofView[];
};

export type OpsBarredProofView = {
  proofId: string;
  submittedAt: string;
  attempt: number;
  rejectionReason: string | null;
  grossAmount: number;
  currency: string;
  dueAt: string | null;
  payerDisplayName: string;
  competitionTitle: string;
  institutionSlug: string;
};

/**
 * The one control an operator has on a blocked payment: voiding a bukti transfer.
 *
 * THE VOID IS NOT GUARDED HERE BEYOND WHAT THE SERVICE ENFORCES. It is the only way to release a
 * transfer no organiser will rule on, so a gate here tighter than platform_ops itself would strand
 * the organiser and the payer the block protects. Voiding says nothing about the competition: it
 * releases the transfer, and the organiser then withdraws the competition themselves.
 */
export function OpsPaymentActions({
  competitions,
  barredProofs,
}: {
  competitions: OpsCompetitionView[];
  barredProofs: OpsBarredProofView[];
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal } = useModal();

  // The reason pop-up shows the waiting and the failure, so this reports an outcome.
  const post = async (
    url: string,
    reason: string,
    successMessage: string,
    refusalFallback: string,
  ): Promise<ModalOutcome> => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        return {
          ok: false,
          message: errorMessageFor(payload?.error?.code, OPS_PAYMENT_ERROR_COPY, refusalFallback),
        };
      }

      addToast({ type: "success", message: successMessage });
      router.refresh();
      return { ok: true };
    } catch {
      return { ok: false, message: "Tindakan gagal disimpan karena gangguan koneksi." };
    }
  };

  const openVoid = (competition: OpsCompetitionView, proof: OpsProofView) => {
    openModal({
      title: "Batalkan bukti transfer",
      wide: true,
      formId: OPS_REASON_FORM_ID,
      body: (
        <ReasonForm
          intro={`${proof.payerDisplayName} · ${formatRupiah(proof.grossAmount, proof.currency)} · ${competition.title}`}
          // Both consequences, stated before the operator commits. The second is the one that is
          // easy to forget: a void releases the DEC-0132 block, so the organiser can then unpublish
          // this competition themselves.
          warning="Bukti transfer ini akan dibatalkan tanpa keputusan apa pun mengenai dananya, dan peserta dapat mengirim bukti baru. Tidak ada catatan keuangan yang ditulis. Tindakan ini juga membuka kembali blokir penarikan kompetisi bagi penyelenggara."
          placeholder="Contoh: bukti transfer milik peserta lain, diunggah ke pendaftaran yang keliru."
          onSubmit={(reason) =>
            post(
              `/api/platform-ops/payments/proofs/${proof.proofId}/void`,
              reason,
              "Bukti transfer dibatalkan.",
              VOID_PROOF_FALLBACK,
            )
          }
        />
      ),
      actions: [{ label: "Kembali" }, { label: "Batalkan bukti transfer", variant: "primary" }],
    });
  };

  // The same dialog and the same endpoint as a pending void. Only the warning differs, because
  // what this one releases is a person rather than a competition.
  const openBarredVoid = (proof: OpsBarredProofView) => {
    openModal({
      title: "Batalkan bukti transfer",
      wide: true,
      formId: OPS_REASON_FORM_ID,
      body: (
        <ReasonForm
          intro={`${proof.payerDisplayName} · ${formatRupiah(proof.grossAmount, proof.currency)} · ${proof.competitionTitle}`}
          warning="Penyelenggara menolak bukti ini dan melarang pengiriman ulang, sehingga peserta tidak dapat berbuat apa pun. Membatalkannya membuka kembali kesempatan mengirim bukti baru sebelum batas waktu. Tidak ada catatan keuangan yang ditulis dan tidak ada keputusan atas dananya."
          placeholder="Contoh: peserta menghubungi dukungan dengan bukti transfer yang sah."
          onSubmit={(reason) =>
            post(
              `/api/platform-ops/payments/proofs/${proof.proofId}/void`,
              reason,
              "Bukti transfer dibatalkan.",
              VOID_PROOF_FALLBACK,
            )
          }
        />
      ),
      actions: [{ label: "Kembali" }, { label: "Batalkan bukti transfer", variant: "primary" }],
    });
  };

  return (
    <>
      <PageSection title="Kompetisi tertahan">
        {competitions.length === 0 ? (
          <EmptyState
            kind="queue-clear"
            size="compact"
            title="Tidak ada pembayaran yang tertahan"
            description="Pembayaran yang perlu ditinjau akan muncul di sini."
          />
        ) : (
          <ul className="record-list">
            {competitions.map((competition) => (
              <li key={competition.competitionId}>
                <div className="stack-md">
                  <div className="section-heading">
                    <div>
                      <p>{competition.institutionSlug}</p>
                      <h3>{competition.title}</h3>
                    </div>
                    {/* Both values must be tones the stylesheet defines; `warning` and `neutral` are not
                      among them, and a badge carrying an undefined tone renders as an uncoloured pill
                      with no dot rather than failing anywhere a reviewer would see it. */}
                    <span
                      className="status-badge"
                      data-status={competition.status === "published" ? "open" : "closed"}
                    >
                      {competition.status === "published" ? "Terbit" : "Tidak terbit"}
                    </span>
                  </div>

                  <ul className="record-list">
                    {competition.proofs.map((proof) => (
                      <li key={proof.proofId}>
                        <Card className="stack-sm">
                          <div className="section-heading">
                            <div>
                              <h4>{proof.payerDisplayName}</h4>
                              <p className="muted-copy">
                                {formatRupiah(proof.grossAmount, proof.currency)}
                                {proof.attempt > 0 ? ` · Percobaan ke-${proof.attempt + 1}` : ""}
                              </p>
                            </div>
                            <span
                              className="status-badge"
                              data-status={PROOF_STATUS_TONES[proof.status]}
                            >
                              {PROOF_STATUS_LABELS[proof.status]}
                            </span>
                          </div>

                          <dl className="detail-grid">
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
                          </dl>

                          {/* WITHHELD, not disabled, on a verified proof. The void CAS accepts only
                            `pending_review`; a disabled button would advertise an action this surface
                            cannot perform and send the operator looking for the permission to enable
                            it. The sentence below says what would have to happen instead. */}
                          {proof.voidable ? (
                            <div className="record-actions">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => openVoid(competition, proof)}
                              >
                                Batalkan bukti transfer
                              </Button>
                            </div>
                          ) : (
                            <p className="muted-copy">
                              Sudah diverifikasi penyelenggara. Pembatalan bukti tidak berlaku lagi.
                              Koreksi pembayaran yang sudah diverifikasi ditangani terpisah.
                            </p>
                          )}
                        </Card>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageSection>

      {/* THE SECOND LIST, AND THE ONLY ROUTE TO IT. These proofs hold no competition open, so they
          never appear above, but their payers cannot resubmit, cannot cancel, and have no
          organiser control left to appeal to. Without this section an operator could release them
          only by knowing a proof id. */}
      {barredProofs.length > 0 && (
        <section className="content-section">
          <h2>Peserta yang tidak dapat mengirim ulang</h2>
          <p className="muted-copy">
            Penyelenggara menolak bukti transfer ini dan melarang pengiriman ulang. Hanya tim
            Lombakita yang dapat membuka kembali kesempatan itu sebelum batas waktu terlewat.
          </p>
          <ul className="record-list">
            {barredProofs.map((proof) => (
              <li key={proof.proofId}>
                <Card className="stack-sm">
                  <div className="section-heading">
                    <div>
                      <p>{proof.institutionSlug}</p>
                      <h3>{proof.payerDisplayName}</h3>
                      <p className="muted-copy">
                        {`${formatRupiah(proof.grossAmount, proof.currency)} · ${proof.competitionTitle}`}
                        {proof.attempt > 0 ? ` · Percobaan ke-${proof.attempt + 1}` : ""}
                      </p>
                    </div>
                  </div>

                  <dl className="detail-grid">
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
                  </dl>

                  {proof.rejectionReason ? (
                    <Feedback tone="error">
                      {`Alasan penyelenggara: ${asSentence(proof.rejectionReason)}`}
                    </Feedback>
                  ) : null}

                  <div className="record-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openBarredVoid(proof)}
                    >
                      Batalkan bukti transfer
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * A mandatory reason, and the consequence stated above the field.
 *
 * The reason is required by the service and refused server-side when blank; requiring it here as
 * well is what stops an operator discovering that by submitting. Every action on this surface
 * overrides a participant protection, and the reason is the only record of why.
 */
function ReasonForm({
  intro,
  warning,
  placeholder,
  onSubmit,
}: {
  intro: string;
  warning: string;
  placeholder: string;
  onSubmit: (reason: string) => Promise<ModalOutcome>;
}) {
  const runModalTask = useModalTask();
  const [reason, setReason] = useState("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedReason = reason.trim();
  const showsReasonError = hasTriedToSubmit && trimmedReason.length === 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (trimmedReason.length === 0) return;
    void runModalTask(() => onSubmit(trimmedReason));
  };

  return (
    <form id={OPS_REASON_FORM_ID} noValidate onSubmit={submit} className="stack-md">
      <p>{intro}</p>
      <Feedback tone="warning">{warning}</Feedback>

      <FormField>
        <FormLabel htmlFor="ops-reason" required>
          Alasan
        </FormLabel>
        <FormTextarea
          id="ops-reason"
          value={reason}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          placeholder={placeholder}
          aria-invalid={showsReasonError ? true : undefined}
          aria-describedby={showsReasonError ? "ops-reason-error" : undefined}
        />
        {showsReasonError ? (
          <FormError id="ops-reason-error">{OPS_PAYMENT_ERROR_COPY.ops_reason_required}</FormError>
        ) : null}
      </FormField>
    </form>
  );
}
