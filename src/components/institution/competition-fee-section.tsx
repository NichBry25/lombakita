"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CheckboxField, Feedback, Skeleton } from "@/components/ui";
import {
  useCompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { computePlatformFee, type FeeRuleTerms } from "@/lib/finance/fee";
import { formatRupiah } from "@/lib/finance/payment-display";

type FeeRule = {
  basisPoints: number;
  flatAmount: number;
  currency: string;
  minimumFeeAmount: number | null;
  maximumFeeAmount: number | null;
};

type FeeState = {
  pricing: { feeAmount: number | null; feeCurrency: string | null; paymentWindowDays: number };
  feeRule: FeeRule | null;
};

const CURRENCY = "IDR";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  competition_not_found: "Kompetisi tidak ditemukan.",
  forbidden: "Hanya pemilik institusi yang dapat mengatur biaya pendaftaran.",
  competition_invalid_value: "Periksa biaya, mata uang, dan batas waktu pembayaran lalu coba lagi.",
  competition_fee_change_blocked_payment_in_flight:
    "Biaya tidak dapat diubah selama masih ada bukti transfer yang menunggu verifikasi.",
  competition_fee_blocked_free_registrations:
    "Biaya tidak dapat ditetapkan karena sudah ada pendaftar yang mendaftar tanpa biaya.",
  competition_institution_not_verified:
    "Institusi harus terverifikasi sebelum dapat memungut biaya pendaftaran. Kompetisi gratis tetap dapat dipublikasikan.",
  payment_instructions_missing:
    "Lengkapi informasi pembayaran institusi Anda sebelum mengaktifkan pendaftaran berbayar.",
  fee_rule_not_in_force:
    "Tarif layanan Lombakita belum dikonfigurasi, sehingga pendaftaran berbayar belum dapat diaktifkan. Hubungi tim Lombakita.",
  competition_fee_disclosure_required:
    "Setujui rincian biaya layanan Lombakita sebelum mengaktifkan pendaftaran berbayar.",
};

const SAVE_FALLBACK = "Biaya pendaftaran gagal disimpan. Coba lagi.";

const LOAD_FAILURE_MESSAGE = "Biaya pendaftaran gagal dimuat. Muat ulang halaman lalu coba lagi.";

const LOAD_ERROR_COPY: Partial<Record<string, string>> = { forbidden: SAVE_ERROR_COPY.forbidden };

type FeeFormValues = { isPaid: boolean; amountText: string; windowDays: string };

const feeFormDiffers = (current: FeeFormValues, saved: FeeFormValues): boolean =>
  current.isPaid !== saved.isPaid ||
  current.windowDays !== saved.windowDays ||
  (current.isPaid && current.amountText !== saved.amountText);

const describeIncompletePaidFee = (hasAmount: boolean, feeRuleIsConfigured: boolean): string => {
  if (!hasAmount) return "Isi biaya per pendaftaran.";
  if (!feeRuleIsConfigured) {
    return errorMessageFor("fee_rule_not_in_force", SAVE_ERROR_COPY, SAVE_FALLBACK);
  }
  return errorMessageFor("competition_fee_disclosure_required", SAVE_ERROR_COPY, SAVE_FALLBACK);
};

const FeeSectionNotice = ({ code }: { code: string | null }) => {
  const tone = code === "forbidden" ? "info" : "error";
  const message = errorMessageFor(code, LOAD_ERROR_COPY, LOAD_FAILURE_MESSAGE);
  return (
    <section className="content-section surface-card card-padding">
      <div className="section-heading">
        <div>
          <h2>Biaya pendaftaran</h2>
        </div>
      </div>
      <Feedback tone={tone}>{message}</Feedback>
    </section>
  );
};

/**
 * Turning paid registration on, and the disclosure that has to happen first.
 *
 * The disclosure is not a link to a pricing page and not a percentage the organiser is left to
 * apply themselves. It states, for the exact amount typed into the field above it, what the
 * candidate pays, what Lombakita takes and what reaches the institution, recomputed as the number
 * changes, using the same `computePlatformFee` the ledger will use, so the figure shown and the
 * figure charged cannot drift.
 *
 * The acknowledgement is RECORDED server-side with the rate snapshot, not merely displayed. A
 * disclosure that leaves no evidence is worth nothing in the billing dispute it exists to settle.
 */
export function CompetitionFeeSection({
  competitionId,
  expectedUserId,
  viewerIsOwner,
}: {
  competitionId: string;
  expectedUserId: string;
  viewerIsOwner: boolean;
}) {
  // Staff never mount the form, so it never loads, never joins the shell's save and never sends a
  // fee. The server refuses them as well (fee/route.ts, owner-only).
  if (!viewerIsOwner) return <FeeSectionNotice code="forbidden" />;
  return <OwnerFeeForm competitionId={competitionId} expectedUserId={expectedUserId} />;
}

function OwnerFeeForm({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) {
  const [state, setState] = useState<FeeState | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [windowDays, setWindowDays] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [savedFee, setSavedFee] = useState<FeeFormValues>({
    isPaid: false,
    amountText: "",
    windowDays: "",
  });
  const [savedAcknowledgement, setSavedAcknowledgement] = useState(false);
  // The code is null when the request threw or its body could not be read.
  const [loadFailure, setLoadFailure] = useState<{ code: string | null } | null>(null);

  const base = `/api/v1/competitions/${encodeURIComponent(competitionId)}/fee`;

  const load = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(base, { credentials: "include" });
    } catch {
      setLoadFailure({ code: null });
      return;
    }
    if (!response.ok) {
      const code = await readErrorCode(response);
      setLoadFailure({ code });
      return;
    }

    let data: FeeState;
    try {
      data = (await response.json()) as FeeState;
    } catch {
      setLoadFailure({ code: null });
      return;
    }
    const loadedFee: FeeFormValues = {
      isPaid: (data.pricing.feeAmount ?? 0) > 0,
      amountText: data.pricing.feeAmount ? String(data.pricing.feeAmount) : "",
      windowDays: String(data.pricing.paymentWindowDays),
    };
    setState(data);
    setIsPaid(loadedFee.isPaid);
    setAmountText(loadedFee.amountText);
    setWindowDays(loadedFee.windowDays);
    setSavedFee(loadedFee);
  }, [base]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const amount = Number.parseInt(amountText, 10);
  const hasAmount = Number.isSafeInteger(amount) && amount > 0;

  const feeRule = state?.feeRule ?? null;
  const terms: FeeRuleTerms | null =
    feeRule === null
      ? null
      : {
          basisPoints: feeRule.basisPoints,
          flatAmount: feeRule.flatAmount,
          minimumFeeAmount: feeRule.minimumFeeAmount,
          maximumFeeAmount: feeRule.maximumFeeAmount,
          currency: feeRule.currency as FeeRuleTerms["currency"],
        };

  // Computed with the ledger's own function, so what the organiser is shown and what they are
  // billed are the same arithmetic rather than two implementations that agree today.
  const preview = terms !== null && hasAmount ? computePlatformFee(amount, terms) : null;

  // The acknowledgement is meaningless unless there is something to acknowledge. Requiring the
  // preview to exist is what stops a checkbox being ticked against a blank disclosure.
  const canEnable = hasAmount && preview !== null && acknowledged;

  const isDirty =
    feeFormDiffers({ isPaid, amountText, windowDays }, savedFee) ||
    (isPaid && acknowledged && !savedAcknowledgement);

  const saveFee = async (): Promise<CompetitionPartSaveResult> => {
    // Sent anyway, a paid form without an amount arrives as null and clears the stored fee.
    if (isPaid && !canEnable) {
      return { ok: false, errorMessage: describeIncompletePaidFee(hasAmount, terms !== null) };
    }
    const sentValues: FeeFormValues = { isPaid, amountText, windowDays };
    try {
      const response = await sessionFetch(expectedUserId, base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feeAmount: isPaid ? amount : 0,
          feeCurrency: isPaid ? CURRENCY : null,
          paymentWindowDays: Number.parseInt(windowDays, 10),
          feeDisclosureAcknowledged: isPaid ? acknowledged : false,
        }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        return { ok: false, errorMessage: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK) };
      }
      setSavedFee(sentValues);
      setSavedAcknowledgement(isPaid && acknowledged);
      await load();
      return { ok: true };
    } catch {
      return {
        ok: false,
        errorMessage: "Biaya pendaftaran gagal disimpan karena gangguan koneksi.",
      };
    }
  };

  useCompetitionEditorPart("fee", isDirty, saveFee);

  // Only a failure before the first answer replaces the section; a failed reload after a save keeps
  // the form that is already on screen.
  if (state === null && loadFailure !== null) {
    // A viewer passed in as the owner can still be refused, for example after losing the owner role
    // in another tab.
    return <FeeSectionNotice code={loadFailure.code} />;
  }

  if (state === null) {
    return (
      <section className="content-section surface-card card-padding">
        <div className="stack-md" aria-label="Memuat biaya pendaftaran">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
        </div>
      </section>
    );
  }

  return (
    <section className="content-section surface-card card-padding">
      <div className="section-heading">
        <div>
          <h2>Biaya pendaftaran</h2>
        </div>
      </div>

      <div className="stack-md">
        <span className="form-label">Jenis pendaftaran</span>
        <CheckboxField
          id="fee-paid"
          checked={isPaid}
          onChange={(event) => {
            setIsPaid(event.target.checked);
            // Consent does not survive a change to what is being consented to. Unticking and
            // reticking "berbayar" has to ask again, or an acknowledgement recorded for one price
            // would carry over to another.
            setAcknowledged(false);
          }}
        >
          Pendaftaran berbayar
        </CheckboxField>

        {isPaid ? (
          <>
            <div className="form-field">
              <label className="form-label" htmlFor="fee-amount">
                Biaya per pendaftaran
              </label>
              <input
                id="fee-amount"
                className="form-input"
                inputMode="numeric"
                value={amountText}
                maxLength={12}
                placeholder="150000"
                onChange={(event) => {
                  setAmountText(event.target.value.replace(/[^0-9]/g, ""));
                  setAcknowledged(false);
                }}
              />
              <p className="form-help">Dalam rupiah penuh, tanpa titik atau koma.</p>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="fee-window">
                Batas waktu pembayaran (hari)
              </label>
              <input
                id="fee-window"
                className="form-input"
                inputMode="numeric"
                value={windowDays}
                maxLength={3}
                onChange={(event) => setWindowDays(event.target.value.replace(/[^0-9]/g, ""))}
              />
              <p className="form-help">
                Peserta yang belum membayar setelah batas ini kehilangan pendaftarannya.
              </p>
            </div>

            {/* THE DISCLOSURE. Rendered from the live amount, never as a static rate. */}
            {state.feeRule === null ? (
              <Feedback tone="error">
                Tarif layanan Lombakita belum dikonfigurasi, sehingga pendaftaran berbayar belum
                dapat diaktifkan. Hubungi tim Lombakita.
              </Feedback>
            ) : preview === null ? (
              <Feedback tone="info">
                Masukkan biaya pendaftaran untuk melihat rincian potongan layanan.
              </Feedback>
            ) : (
              <Card variant="inset" className="stack-sm">
                <p className="form-label">Rincian per pendaftaran</p>
                <dl className="detail-grid">
                  <div>
                    <dt>Dibayar peserta</dt>
                    <dd className="data-text">{formatRupiah(preview.grossAmount, CURRENCY)}</dd>
                  </div>
                  <div>
                    <dt>Biaya layanan Lombakita</dt>
                    <dd className="data-text">
                      {formatRupiah(preview.platformFeeAmount, CURRENCY)}
                    </dd>
                  </div>
                  <div>
                    <dt>Diterima lembaga Anda</dt>
                    <dd className="data-text">
                      {formatRupiah(preview.institutionNetAmount, CURRENCY)}
                    </dd>
                  </div>
                </dl>
                <p className="form-help">
                  Dana peserta masuk langsung ke rekening lembaga Anda. Biaya layanan dicatat
                  sebagai tagihan Lombakita kepada lembaga, bukan dipotong dari transfer peserta.
                </p>
              </Card>
            )}

            {/* WITHHELD, not disabled, when there are no figures. A disabled checkbox under an
                error the organiser cannot act on invites them to try to tick it; there is simply
                nothing to agree to until the disclosure above renders. */}
            {preview !== null ? (
              <CheckboxField
                id="fee-ack"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              >
                Saya menyetujui rincian biaya layanan di atas.
              </CheckboxField>
            ) : null}
          </>
        ) : (
          <p className="muted-copy">
            Pendaftaran gratis. Aktifkan pendaftaran berbayar untuk menetapkan biaya.
          </p>
        )}
      </div>
    </section>
  );
}
