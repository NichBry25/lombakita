import { redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import {
  EmptyState,
  Feedback,
  PageHeader,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { loadInstitutionFeeStatement, type FeeStatementLine } from "@/server/finance/fee-statement";
import { formatBasisPoints } from "@/lib/finance/fee-display";
import { LocalDate } from "@/components/ui/local-date";
import { formatRupiah } from "@/lib/finance/payment-display";

type Props = { params: Promise<{ institutionSlug: string }> };

const LINE_COLUMNS: readonly TableColumn[] = [
  { key: "date", header: "Tanggal", kind: "date" },
  { key: "competition", header: "Kompetisi", kind: "long" },
  { key: "grossAmount", header: "Biaya pendaftaran", kind: "number" },
  { key: "rate", header: "Tarif saat itu", kind: "number" },
  { key: "fee", header: "Biaya layanan", kind: "number" },
];

const describeCompetition = (line: FeeStatementLine): string => {
  const title = line.competitionTitle ?? "—";
  const correction = line.entryType === "reversed" ? " (koreksi)" : "";
  const reason = line.reason ? ` · ${line.reason}` : "";
  return `${title}${correction}${reason}`;
};

// THE RATE AS IT STOOD ON THIS LINE, read from the accrual's own snapshot. Rendering today's rate
// against a historical line would show a figure that was never charged.
const describeRateAtThatTime = (line: FeeStatementLine): string => {
  const rate = formatBasisPoints(line.feeBasisPoints);
  if (line.feeFlatAmount <= 0) return rate;
  return `${rate} + ${formatRupiah(line.feeFlatAmount, line.currency)}`;
};

// `Math.abs` because the stored amount on a `reversed` row is already negative. Formatting it
// as-is under an explicit "−" prints the sign twice.
const describeServiceFee = (line: FeeStatementLine): string => {
  const sign = line.entryType === "reversed" ? "−" : "";
  return `${sign}${formatRupiah(Math.abs(line.amount), line.currency)}`;
};

const ACKNOWLEDGEMENT_COLUMNS: readonly TableColumn[] = [
  { key: "name", header: "Nama", kind: "name" },
  { key: "rate", header: "Tarif disetujui", kind: "number" },
  { key: "fee", header: "Untuk biaya", kind: "number" },
  { key: "approvedAt", header: "Disetujui", kind: "date" },
];

export const metadata = {
  title: "Biaya layanan tercatat",
  description: "Rincian biaya layanan Lombakita yang tercatat atas lembaga Anda.",
};

/**
 * What this institution owes Lombakita, and what it agreed to.
 *
 * THE DIRECTION IS THE WHOLE DESIGN (DEC-0163). Under DEC-0130 the participant's transfer goes
 * straight into this institution's own bank account and the platform never touches it, so the
 * service fee was never withheld from anything. It is billed afterwards. Every line of copy here
 * has to say "owed by you" rather than "held for you", because an organiser who reads this as a
 * balance will sit waiting for a payout that does not exist.
 *
 * NOT AN INVOICE (R8). No due date, no payment instruction, no reversal control: this records what
 * has accrued, and nothing in the product settles it yet. Saying so plainly is better than a
 * surface that looks like a bill and cannot be paid.
 *
 * Gated for owners AND staff, via `requireAdminInstitutionBySlug`, which is owner-or-staff and a
 * wider set than the owner-only gate on SETTING a price. Reading what the institution owes is
 * ordinary finance work for the people who run its competitions; agreeing to owe it is not.
 */
export default async function InstitutionFeeStatementPage({ params }: Props) {
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/fees`;
  const session = await requireRolePage("recruiter", { callbackPath: path });

  const db = getDb();
  let institutionId: string;
  try {
    ({ institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    ));
  } catch (error) {
    if (error instanceof AccessError && error.code === "account_state_unavailable") throw error;
    if (error instanceof AccessError) redirect("/");
    throw error;
  }

  const statement = await loadInstitutionFeeStatement(institutionId, db);
  const currency = statement.currency ?? "IDR";

  const lineRows: TableRowData[] = statement.lines.map((line) => ({
    key: line.accrualId,
    cells: {
      date: <LocalDate value={line.recordedAt} format="shortDateTime" />,
      competition: describeCompetition(line),
      grossAmount: formatRupiah(line.grossAmount, line.currency),
      rate: describeRateAtThatTime(line),
      fee: describeServiceFee(line),
    },
  }));

  // An approval has no id of its own, so a row is told apart by its competition and the moment it
  // was approved.
  const acknowledgementRows: TableRowData[] = statement.acknowledgements.map((ack) => ({
    key: `${ack.competitionId}:${ack.acknowledgedAt.toISOString()}`,
    cells: {
      name: ack.competitionTitle,
      rate: formatBasisPoints(ack.feeBasisPoints),
      fee: formatRupiah(ack.feeAmount, ack.feeCurrency),
      approvedAt: <LocalDate value={ack.acknowledgedAt} format="shortDateTime" />,
    },
  }));

  return (
    <main className="page-shell app-page">
      <PageHeader
        title="Biaya layanan tercatat"
        description="Biaya layanan Lombakita yang tercatat atas setiap pembayaran peserta yang Anda verifikasi."
        backHref={`/institution/${institutionSlug}`}
      />

      <Feedback tone="info" lead="Biaya layanan tidak dipotong dari transfer peserta.">
        Angka di bawah adalah catatan tagihan, bukan saldo yang kami simpan, dan belum ada penagihan
        yang berjalan.
      </Feedback>

      <div className="stack-md">
        <h2>Ringkasan</h2>
        <dl className="detail-grid">
          <div>
            <dt>Total tercatat</dt>
            <dd className="data-text">{formatRupiah(statement.accruedAmount, currency)}</dd>
          </div>
          {statement.reversedAmount > 0 ? (
            <div>
              <dt>Koreksi</dt>
              <dd className="data-text">−{formatRupiah(statement.reversedAmount, currency)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Belum ditagihkan</dt>
            <dd className="data-text">{formatRupiah(statement.outstandingAmount, currency)}</dd>
          </div>
        </dl>
      </div>

      <section className="content-section">
        <h2>Rincian</h2>
        {statement.lines.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada biaya layanan"
            description="Biaya layanan tercatat saat Anda memverifikasi pembayaran peserta pertama."
          />
        ) : (
          <Table label="Rincian" columns={LINE_COLUMNS} rows={lineRows} />
        )}
      </section>

      <section className="content-section">
        <h2>Persetujuan tarif</h2>
        <p className="muted-copy">
          Tarif yang Anda setujui sebelum mengaktifkan pendaftaran berbayar, tersimpan apa adanya
          pada saat persetujuan.
        </p>
        {statement.acknowledgements.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada persetujuan tarif"
            description="Persetujuan tercatat saat Anda mengaktifkan pendaftaran berbayar pada sebuah kompetisi."
          />
        ) : (
          <Table
            label="Persetujuan tarif"
            columns={ACKNOWLEDGEMENT_COLUMNS}
            rows={acknowledgementRows}
          />
        )}
      </section>
    </main>
  );
}
