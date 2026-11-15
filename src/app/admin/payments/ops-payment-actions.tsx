"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  EmptyState,
  Feedback,
  PageSection,
  FormField,
  FormLabel,
  FormTextarea,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { getCompetitionStatusLabel } from "@/lib/competitions/status-labels";
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
  ops_competition_not_found: "Kompetisi tidak ditemukan.",
  ops_competition_not_published:
    "Kompetisi ini sudah tidak berstatus terbit. Muat ulang halaman untuk melihat status terbaru.",
  ops_competition_payment_in_flight:
    "Kompetisi tidak dapat dibatalkan selama masih ada bukti transfer yang menunggu verifikasi atau sudah diverifikasi. Selesaikan dulu setiap bukti yang menunggu: penyelenggara memverifikasi atau menolaknya, atau Anda membatalkan bukti itu. Kompetisi dengan transfer yang sudah diverifikasi tidak dapat dibatalkan.",
  ops_competition_concurrently_modified:
    "Status kompetisi sudah berubah. Muat ulang halaman lalu coba lagi.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
};

const VOID_PROOF_FALLBACK = "Bukti transfer gagal dibatalkan. Coba lagi.";
const CANCEL_COMPETITION_FALLBACK = "Kompetisi gagal dibatalkan. Coba lagi.";

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
  cancellable: boolean;
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
 * The DEC-0132 escape hatch, as an operator uses it.
 *
 * TWO ACTIONS AT TWO LEVELS, deliberately kept apart. Voiding one bukti transfer says nothing about
 * the competition; cancelling the competition says nothing about the transfers, and the service
 * refuses to bundle them for the same reason: one click must not both cancel a competition and
 * discard the evidence that somebody paid for it.
 *
 * NEITHER ACTION IS GUARDED HERE BEYOND WHAT THE SERVICE ENFORCES. The void is the only way to
 * release a transfer no organiser will rule on, so a gate here tighter than platform_ops itself
 * would strand the organiser and the payer the block protects. The service refuses the cancellation
 * while any transfer on the competition is in flight, and the refusal says why.
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
  const { openModal, closeModal } = useModal();
  // Keyed by target, so the spinner sits on the control that was pressed rather than on all of them.
  const [pending, setPending] = useState<string | null>(null);

  const post = async (
    key: string,
    url: string,
    reason: string,
    successMessage: string,
    refusalFallback: string,
  ): Promise<void> => {
    setPending(key);
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
        addToast({
          type: "error",
          message: errorMessageFor(payload?.error?.code, OPS_PAYMENT_ERROR_COPY, refusalFallback),
        });
        return;
      }

      addToast({ type: "success", message: successMessage });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Tindakan gagal disimpan karena gangguan koneksi." });
    } finally {
      setPending(null);
    }
  };

  const openVoid = (competition: OpsCompetitionView, proof: OpsProofView) => {
    openModal({
      title: "Batalkan bukti transfer",
      body: (
        <ReasonForm
          intro={`${proof.payerDisplayName} · ${formatRupiah(proof.grossAmount, proof.currency)} · ${competition.title}`}
          // Both consequences, stated before the operator commits. The second is the one that is
          // easy to forget: a void releases the DEC-0132 block, so the organiser can then unpublish
          // this competition themselves.
          warning="Bukti transfer ini akan dibatalkan tanpa keputusan apa pun mengenai dananya, dan peserta dapat mengirim bukti baru. Tidak ada catatan keuangan yang ditulis. Tindakan ini juga membuka kembali blokir penarikan kompetisi bagi penyelenggara."
          placeholder="Contoh: bukti transfer milik peserta lain, diunggah ke pendaftaran yang keliru."
          submitLabel="Batalkan bukti transfer"
          onSubmit={(reason) =>
            post(
              `void:${proof.proofId}`,
              `/api/platform-ops/payments/proofs/${proof.proofId}/void`,
              reason,
              "Bukti transfer dibatalkan.",
              VOID_PROOF_FALLBACK,
            )
          }
          onDone={closeModal}
        />
      ),
      actions: [],
    });
  };

  // The same dialog and the same endpoint as a pending void. Only the warning differs, because
  // what this one releases is a person rather than a competition.
  const openBarredVoid = (proof: OpsBarredProofView) => {
    openModal({
      title: "Batalkan bukti transfer",
      body: (
        <ReasonForm
          intro={`${proof.payerDisplayName} · ${formatRupiah(proof.grossAmount, proof.currency)} · ${proof.competitionTitle}`}
          warning="Penyelenggara menolak bukti ini dan melarang pengiriman ulang, sehingga peserta tidak dapat berbuat apa pun. Membatalkannya membuka kembali kesempatan mengirim bukti baru sebelum batas waktu. Tidak ada catatan keuangan yang ditulis dan tidak ada keputusan atas dananya."
          placeholder="Contoh: peserta menghubungi dukungan dengan bukti transfer yang sah."
          submitLabel="Batalkan bukti transfer"
          onSubmit={(reason) =>
            post(
              `void:${proof.proofId}`,
              `/api/platform-ops/payments/proofs/${proof.proofId}/void`,
              reason,
              "Bukti transfer dibatalkan.",
              VOID_PROOF_FALLBACK,
            )
          }
          onDone={closeModal}
        />
      ),
      actions: [],
    });
  };

  const openCancel = (competition: OpsCompetitionView) => {
    openModal({
      title: "Batalkan kompetisi",
      body: (
        <ReasonForm
          intro={`${competition.title} · ${competition.proofs.length} bukti transfer belum selesai`}
          // R8 in one sentence, and it is stated because no part of this flow can undo it: the fee
          // already accrued to the institution stays accrued, and cancelled registrations are
          // terminal.
          warning="Kompetisi akan turun ke draf dan seluruh pendaftaran dibatalkan secara permanen. Biaya layanan yang sudah tercatat tidak dibatalkan. Peserta yang sudah transfer akan diberi tahu untuk menghubungi penyelenggara soal pengembalian dana."
          placeholder="Contoh: penyelenggara membatalkan acara dan meminta penarikan lewat dukungan."
          submitLabel="Batalkan kompetisi"
          onSubmit={(reason) =>
            post(
              `cancel:${competition.competitionId}`,
              `/api/platform-ops/competitions/${competition.competitionId}/cancel`,
              reason,
              "Kompetisi dibatalkan.",
              CANCEL_COMPETITION_FALLBACK,
            )
          }
          onDone={closeModal}
        />
      ),
      actions: [],
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
                      data-status={competition.cancellable ? "open" : "closed"}
                    >
                      {competition.cancellable ? "Terbit" : "Tidak terbit"}
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
                                loading={pending === `void:${proof.proofId}`}
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

                  {competition.cancellable ? (
                    <div className="record-actions">
                      <Button
                        type="button"
                        variant="outline"
                        loading={pending === `cancel:${competition.competitionId}`}
                        onClick={() => openCancel(competition)}
                      >
                        Batalkan kompetisi
                      </Button>
                    </div>
                  ) : (
                    <Feedback tone="neutral">
                      {`Kompetisi ini berstatus ${getCompetitionStatusLabel(competition.status)}, bukan Terbit, sehingga tidak ada penarikan yang perlu diambil alih.`}
                    </Feedback>
                  )}
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
                      loading={pending === `void:${proof.proofId}`}
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
  submitLabel,
  onSubmit,
  onDone,
}: {
  intro: string;
  warning: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    await onSubmit(reason.trim());
    setSubmitting(false);
    onDone();
  };

  return (
    <div className="stack-md">
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
        />
      </FormField>

      <div className="record-actions">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Batal
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={reason.trim().length === 0}
          loading={submitting}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
