import Link from "next/link";
import { EmptyState, Feedback, PageHeader } from "@/components/ui";
import { loadDisputePayments } from "@/server/finance/dispute-view";
import { formatFinanceDateTime, formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";

export const metadata = {
  title: "Sengketa pembayaran",
  description: "Riwayat bukti transfer lintas lembaga untuk penanganan sengketa.",
};

/**
 * Every bukti transfer ever filed, across every institution. This is the finance_ops dispute view.
 *
 * READ-ONLY BY CONSTRUCTION, and the absence of controls is the design (DEC-0162). Under the manual
 * origin the money reaches the organiser's own bank account and never touches platform
 * infrastructure, so finance_ops has no independent record that a transfer happened and no way to
 * confirm one. Only the organiser can look at their statement. There is therefore no verify, no
 * reject and no void anywhere on this surface. Not disabled, ABSENT, because a control that
 * cannot be exercised still tells the operator they are the person who decides, and they are not.
 *
 * Cross-institution on purpose: a dispute arrives naming a person and a competition, not a tenant.
 */
export default async function FinanceDisputePaymentsPage() {
  const payments = await loadDisputePayments();

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Sengketa pembayaran"
        description="Riwayat bukti transfer lintas lembaga. Hanya untuk dibaca."
        actions={
          <span className="status-badge data-text">{`${payments.length} bukti transfer`}</span>
        }
      />

      <Feedback tone="info">
        Keputusan atas bukti transfer dibuat oleh penyelenggara, yang menerima dananya langsung di
        rekening mereka. Halaman ini tidak dapat memverifikasi, menolak, atau membatalkan pembayaran
        mana pun.
      </Feedback>

      {payments.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="Belum ada bukti transfer"
          description="Bukti transfer akan muncul di sini setelah peserta mengunggahnya."
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Peserta</th>
                <th>Kompetisi</th>
                <th>Lembaga</th>
                <th>Jumlah</th>
                <th>Status bukti</th>
                <th>Dikirim</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.paymentId}>
                  <td>
                    <Link href={`/finance/payments/${payment.paymentId}`}>
                      {payment.payerDisplayName}
                    </Link>
                  </td>
                  <td>{payment.competitionTitle}</td>
                  <td className="data-text">{payment.institutionSlug}</td>
                  <td className="data-text">
                    {formatRupiah(payment.grossAmount, payment.currency)}
                  </td>
                  <td>
                    {payment.proofStatus ? (
                      <span
                        className="status-badge"
                        data-status={PROOF_STATUS_TONES[payment.proofStatus]}
                      >
                        {PROOF_STATUS_LABELS[payment.proofStatus]}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {payment.submittedAt ? (
                      <time dateTime={payment.submittedAt.toISOString()}>
                        {formatFinanceDateTime(payment.submittedAt.toISOString())}
                      </time>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
