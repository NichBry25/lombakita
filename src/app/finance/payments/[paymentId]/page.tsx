import { notFound } from "next/navigation";
import { Card, Feedback, PageHeader } from "@/components/ui";
import { loadDisputeLedgerState, loadDisputePaymentDetail } from "@/server/finance/dispute-view";
import { formatFinanceDateTime, formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";
import { formatFileSize } from "@/lib/text/format-file-size";
import { capitalizeWord } from "@/lib/text/capitalize";
import { DisputeProofFileButton } from "./dispute-proof-file-button";

type Props = { params: Promise<{ paymentId: string }> };

export const metadata = {
  title: "Rincian pembayaran",
  description: "Riwayat lengkap satu bukti transfer untuk penanganan sengketa.",
};

/**
 * One payment, read forwards: every attempt in the order it happened, then what the ledger says.
 *
 * THE ATTEMPT HISTORY IS THE REASON THIS PAGE EXISTS. A live proof row shows only the attempt
 * currently standing (a resubmission overwrites the file, the reason and the verdict in place), and
 * a dispute is almost always ABOUT an earlier attempt. Showing the live row alone would answer every
 * disagreement with the state that came after it.
 *
 * NO VERDICT CONTROL APPEARS ANYWHERE, per DEC-0162. The one control here opens the receipt, and it
 * is an act on the payer's data that leaves its own audit row.
 */
export default async function FinanceDisputePaymentDetailPage({ params }: Props) {
  const { paymentId } = await params;

  const detail = await loadDisputePaymentDetail(paymentId);
  if (!detail) notFound();

  const ledger = await loadDisputeLedgerState(paymentId);

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        eyebrow={detail.competitionTitle}
        title={detail.payerDisplayName}
        backHref="/finance/payments"
      />

      <Feedback tone="info">
        Dana pembayaran ini masuk ke rekening lembaga penyelenggara, bukan ke Lombakita. Keputusan
        atas bukti transfer sepenuhnya milik penyelenggara.
      </Feedback>

      <Card variant="surface" className="stack-md">
        <h2>Pembayaran</h2>
        <dl className="detail-grid">
          <div>
            <dt>Lembaga</dt>
            <dd className="data-text">{detail.institutionSlug}</dd>
          </div>
          <div>
            <dt>Jumlah</dt>
            <dd className="data-text">{formatRupiah(detail.grossAmount, detail.currency)}</dd>
          </div>
          <div>
            <dt>Status buku besar</dt>
            {/* FOLDED from the append-only event stream, never read from a column. There is no
                status column to read (DEC-0133). This is what the ledger actually says happened,
                which is the figure a billing dispute turns on. */}
            <dd className="data-text">{capitalizeWord(ledger.status)}</dd>
          </div>
          <div>
            <dt>Tercatat diterima</dt>
            <dd className="data-text">
              {formatRupiah(ledger.netRecordedAmount, ledger.currency ?? detail.currency)}
            </dd>
          </div>
          {detail.dueAt ? (
            <div>
              <dt>Batas waktu</dt>
              <dd>
                <time dateTime={detail.dueAt.toISOString()}>
                  {formatFinanceDateTime(detail.dueAt.toISOString())}
                </time>
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {detail.proofId === null ? (
        <Feedback tone="warning">
          Peserta ini belum pernah mengirim bukti transfer untuk pembayaran tersebut.
        </Feedback>
      ) : (
        <Card variant="surface" className="stack-md">
          <div className="section-heading">
            <div>
              <h2>Bukti transfer terkini</h2>
              <p className="muted-copy">
                {detail.originalFileName}
                {detail.fileSizeBytes ? ` · ${formatFileSize(detail.fileSizeBytes)}` : ""}
              </p>
            </div>
            {detail.proofStatus ? (
              <span className="status-badge" data-status={PROOF_STATUS_TONES[detail.proofStatus]}>
                {PROOF_STATUS_LABELS[detail.proofStatus]}
              </span>
            ) : null}
          </div>

          {detail.rejectionReason ? (
            <Feedback tone="error">{`Alasan tercatat: ${detail.rejectionReason}`}</Feedback>
          ) : null}

          <DisputeProofFileButton proofId={detail.proofId} />
        </Card>
      )}

      <Card variant="surface" className="stack-md">
        <h2>Riwayat percobaan</h2>
        {detail.history.length === 0 ? (
          <p className="muted-copy">
            Belum ada percobaan yang ditutup. Bukti transfer di atas masih percobaan pertama.
          </p>
        ) : (
          <ol className="record-list">
            {detail.history.map((attempt) => (
              <li key={attempt.attemptNumber}>
                <Card variant="inset" className="stack-sm">
                  <div className="section-heading">
                    <div>
                      <h3>{`Percobaan ke-${attempt.attemptNumber + 1}`}</h3>
                      <p className="muted-copy">
                        {attempt.originalFileName} · {formatFileSize(attempt.fileSizeBytes)}
                      </p>
                    </div>
                    <span
                      className="status-badge"
                      data-status={PROOF_STATUS_TONES[attempt.verdict]}
                    >
                      {PROOF_STATUS_LABELS[attempt.verdict]}
                    </span>
                  </div>
                  <dl className="detail-grid">
                    <div>
                      <dt>Dikirim</dt>
                      <dd>
                        <time dateTime={attempt.submittedAt.toISOString()}>
                          {formatFinanceDateTime(attempt.submittedAt.toISOString())}
                        </time>
                      </dd>
                    </div>
                    <div>
                      <dt>Diputus</dt>
                      <dd>
                        <time dateTime={attempt.reviewedAt.toISOString()}>
                          {formatFinanceDateTime(attempt.reviewedAt.toISOString())}
                        </time>
                      </dd>
                    </div>
                  </dl>
                  {attempt.verdictReason ? (
                    <p className="muted-copy">{`Alasan: ${attempt.verdictReason}`}</p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </main>
  );
}
