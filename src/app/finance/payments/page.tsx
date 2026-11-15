import {
  EmptyState,
  Feedback,
  PageHeader,
  Table,
  TableNameLink,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { loadDisputePayments } from "@/server/finance/dispute-view";
import { LocalDate } from "@/components/ui/local-date";
import { formatRupiah } from "@/lib/finance/payment-display";
import { PROOF_STATUS_LABELS, PROOF_STATUS_TONES } from "@/lib/finance/proof-display";
import { requireRolePage } from "@/server/auth/page-guard";

export const metadata = {
  title: "Sengketa pembayaran",
  description: "Riwayat bukti transfer lintas lembaga untuk penanganan sengketa.",
};

const PAYMENT_COLUMNS: readonly TableColumn[] = [
  { key: "payer", header: "Peserta", kind: "name" },
  { key: "competition", header: "Kompetisi", kind: "long" },
  { key: "institution", header: "Lembaga", kind: "text" },
  { key: "amount", header: "Jumlah", kind: "number" },
  { key: "proof", header: "Status bukti", kind: "pill" },
  { key: "submittedAt", header: "Dikirim", kind: "date" },
];

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
  await requireRolePage("finance_ops", { callbackPath: "/finance/payments" });

  const payments = await loadDisputePayments();

  const paymentRows: TableRowData[] = payments.map((payment) => ({
    key: payment.paymentId,
    cells: {
      payer: (
        <TableNameLink href={`/finance/payments/${payment.paymentId}`}>
          {payment.payerDisplayName}
        </TableNameLink>
      ),
      competition: payment.competitionTitle,
      institution: payment.institutionSlug,
      amount: formatRupiah(payment.grossAmount, payment.currency),
      proof: payment.proofStatus ? (
        <span className="status-badge" data-status={PROOF_STATUS_TONES[payment.proofStatus]}>
          {PROOF_STATUS_LABELS[payment.proofStatus]}
        </span>
      ) : null,
      submittedAt: payment.submittedAt ? (
        <LocalDate value={payment.submittedAt} format="shortDateTime" />
      ) : null,
    },
  }));

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Sengketa pembayaran"
        description="Riwayat bukti transfer lintas lembaga. Hanya untuk dibaca."
        titleMark={
          payments.length > 0 ? (
            <span className="status-badge data-text">{`${payments.length} bukti transfer`}</span>
          ) : null
        }
      />

      <Feedback tone="info">
        Keputusan atas bukti transfer dibuat oleh penyelenggara, yang menerima dananya langsung di
        rekening mereka. Halaman ini tidak dapat memverifikasi, menolak, atau membatalkan pembayaran
        mana pun.
      </Feedback>

      {payments.length === 0 ? (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada bukti transfer"
          description="Bukti transfer akan muncul di sini setelah peserta mengunggahnya."
        />
      ) : (
        <Table label="Bukti transfer" columns={PAYMENT_COLUMNS} rows={paymentRows} />
      )}
    </main>
  );
}
