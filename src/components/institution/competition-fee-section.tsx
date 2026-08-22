"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CheckboxField, Feedback, Icon, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { sessionFetch } from "@/lib/session/session-fetch";
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
}: {
  competitionId: string;
  expectedUserId: string;
}) {
  const { addToast } = useToast();

  const [state, setState] = useState<FeeState | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [windowDays, setWindowDays] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const base = `/api/v1/competitions/${encodeURIComponent(competitionId)}/fee`;

  const load = useCallback(async () => {
    const response = await fetch(base, { credentials: "include" });
    if (!response.ok) return;

    const data = (await response.json()) as FeeState;
    setState(data);
    setIsPaid((data.pricing.feeAmount ?? 0) > 0);
    setAmountText(data.pricing.feeAmount ? String(data.pricing.feeAmount) : "");
    setWindowDays(String(data.pricing.paymentWindowDays));
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === null) {
    return (
      <section className="content-section">
        <div className="stack-md" aria-label="Memuat biaya pendaftaran">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
        </div>
      </section>
    );
  }

  const amount = Number.parseInt(amountText, 10);
  const hasAmount = Number.isSafeInteger(amount) && amount > 0;

  const terms: FeeRuleTerms | null =
    state.feeRule === null
      ? null
      : {
          basisPoints: state.feeRule.basisPoints,
          flatAmount: state.feeRule.flatAmount,
          minimumFeeAmount: state.feeRule.minimumFeeAmount,
          maximumFeeAmount: state.feeRule.maximumFeeAmount,
          currency: state.feeRule.currency as FeeRuleTerms["currency"],
        };

  // Computed with the ledger's own function, so what the organiser is shown and what they are
  // billed are the same arithmetic rather than two implementations that agree today.
  const preview = terms !== null && hasAmount ? computePlatformFee(amount, terms) : null;

  // The acknowledgement is meaningless unless there is something to acknowledge. Requiring the
  // preview to exist is what stops a checkbox being ticked against a blank disclosure.
  const canEnable = hasAmount && preview !== null && acknowledged;

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);

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
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Biaya pendaftaran gagal disimpan.",
        });
        return;
      }

      addToast({
        type: "success",
        message: isPaid
          ? "Pendaftaran berbayar diaktifkan."
          : "Pendaftaran dikembalikan ke gratis.",
      });
      await load();
    } catch {
      addToast({
        type: "error",
        message: "Biaya pendaftaran gagal disimpan karena gangguan koneksi.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <h2>Biaya pendaftaran</h2>
        </div>
      </div>

      <form className="stack-md" onSubmit={save}>
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

        <div className="cluster">
          <Button
            type="submit"
            loading={isSaving}
            disabled={isPaid && !canEnable}
            leadingIcon={<Icon name="save" />}
          >
            Simpan biaya pendaftaran
          </Button>
        </div>
      </form>
    </section>
  );
}
