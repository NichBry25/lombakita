import { redirect } from "next/navigation";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { Card, EmptyState, Feedback, PageHeader } from "@/components/ui";
import { loadInstitutionFeeStatement } from "@/server/finance/fee-statement";
import { formatBasisPoints } from "@/lib/finance/fee-display";
import { formatPaymentDeadline, formatRupiah } from "@/lib/finance/payment-display";

type Props = { params: Promise<{ institutionSlug: string }> };

export const metadata = {
  title: "Tagihan biaya layanan",
  description: "Rincian biaya layanan Lombakita yang tercatat atas lembaga Anda.",
};

/**
 * What this institution owes Lombakita, and what it agreed to.
 *
 * THE DIRECTION IS THE WHOLE DESIGN (DEC-0163). Under DEC-0130 the participant's transfer goes
 * straight into this institution's own bank account and the platform never touches it, so the
 * service fee was never withheld from anything — it is billed afterwards. Every line of copy here
 * has to say "owed by you" rather than "held for you", because an organiser who reads this as a
 * balance will sit waiting for a payout that does not exist.
 *
 * NOT AN INVOICE (R8). No due date, no payment instruction, no reversal control: this records what
 * has accrued, and nothing in the product settles it yet. Saying so plainly is better than a
 * surface that looks like a bill and cannot be paid.
 *
 * Gated for owners AND staff — the same admin pair every other institution finance surface uses.
 * Narrowing it to owners would leave the staff member who set the price unable to see its
 * consequence.
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
    if (error instanceof AccessError) redirect("/");
    throw error;
  }

  const statement = await loadInstitutionFeeStatement(institutionId, db);
  const currency = statement.currency ?? "IDR";

  return (
    <main className="page-shell app-page">
      <PageHeader
        title="Tagihan biaya layanan"
        description="Biaya layanan Lombakita yang tercatat atas setiap pembayaran peserta yang Anda verifikasi."
        backHref={`/institution/${institutionSlug}`}
      />

      <Feedback tone="info">
        Dana peserta masuk langsung ke rekening lembaga Anda, sehingga biaya layanan tidak pernah
        dipotong dari transfer mereka. Angka di bawah ini adalah tagihan Lombakita kepada lembaga
        Anda, bukan saldo yang kami simpan untuk Anda. Belum ada proses penagihan yang berjalan —
        halaman ini hanya mencatat.
      </Feedback>

      <Card variant="surface" className="stack-md">
        <h2>Ringkasan</h2>
        <dl className="detail-grid">
          <div>
            <dt>Total tercatat</dt>
            <dd className="data-text">{formatRupiah(statement.accruedAmount, currency)}</dd>
          </div>
          {statement.reversedAmount > 0 ? (
            <div>
              <dt>Koreksi</dt>
              <dd className="data-text">
                −{formatRupiah(statement.reversedAmount, currency)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Belum ditagihkan</dt>
            <dd className="data-text">{formatRupiah(statement.outstandingAmount, currency)}</dd>
          </div>
        </dl>
      </Card>

      <section className="content-section">
        <h2>Rincian</h2>
        {statement.lines.length === 0 ? (
          <EmptyState
            icon="check"
            title="Belum ada biaya layanan"
            description="Biaya layanan tercatat saat Anda memverifikasi pembayaran peserta pertama."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tanggal</th>
                  <th>Kompetisi</th>
                  <th>Biaya pendaftaran</th>
                  <th>Tarif saat itu</th>
                  <th>Biaya layanan</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line) => (
                  <tr key={line.accrualId}>
                    <td>
                      <time dateTime={line.recordedAt.toISOString()}>
                        {formatPaymentDeadline(line.recordedAt.toISOString())}
                      </time>
                    </td>
                    <td>
                      {line.competitionTitle ?? "—"}
                      {line.entryType === "reversed" ? " (koreksi)" : ""}
                      {line.reason ? ` · ${line.reason}` : ""}
                    </td>
                    <td className="data-text">{formatRupiah(line.grossAmount, line.currency)}</td>
                    {/* THE RATE AS IT STOOD ON THIS LINE, read from the accrual's own snapshot.
                        Rendering today's rate against a historical line would show a figure that
                        was never charged. */}
                    <td className="data-text">
                      {formatBasisPoints(line.feeBasisPoints)}
                      {line.feeFlatAmount > 0
                        ? ` + ${formatRupiah(line.feeFlatAmount, line.currency)}`
                        : ""}
                    </td>
                    {/* `Math.abs` because the stored amount on a `reversed` row is already
                        negative — formatting it as-is under an explicit "−" prints the sign twice. */}
                    <td className="data-text">
                      {line.entryType === "reversed" ? "−" : ""}
                      {formatRupiah(Math.abs(line.amount), line.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            icon="info"
            title="Belum ada persetujuan tarif"
            description="Persetujuan tercatat saat Anda mengaktifkan pendaftaran berbayar pada sebuah kompetisi."
          />
        ) : (
          <ul className="record-list">
            {statement.acknowledgements.map((ack) => (
              <li key={ack.competitionId}>
                <div className="inset-panel stack-sm">
                  <h3>{ack.competitionTitle}</h3>
                  <dl className="detail-grid">
                    <div>
                      <dt>Tarif disetujui</dt>
                      <dd className="data-text">{formatBasisPoints(ack.feeBasisPoints)}</dd>
                    </div>
                    <div>
                      <dt>Untuk biaya</dt>
                      <dd className="data-text">
                        {formatRupiah(ack.feeAmount, ack.feeCurrency)}
                      </dd>
                    </div>
                    <div>
                      <dt>Disetujui</dt>
                      <dd>
                        <time dateTime={ack.acknowledgedAt.toISOString()}>
                          {formatPaymentDeadline(ack.acknowledgedAt.toISOString())}
                        </time>
                      </dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
