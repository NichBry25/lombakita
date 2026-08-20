import { EmptyState, Feedback, PageHeader } from "@/components/ui";
import { loadOpsBlockedCompetitions } from "@/server/finance/ops-payment-review";
import { OpsPaymentActions } from "./ops-payment-actions";

export const metadata = {
  title: "Pembayaran tertahan",
  description: "Batalkan bukti transfer atau kompetisi yang tertahan oleh pembayaran berjalan.",
};

/**
 * The DEC-0132 escape hatch, made findable.
 *
 * Protected by /admin/layout.tsx — platform_ops only, with the operational MFA challenge applied by
 * `requireRolePage`, the same choke point every other /admin page sits behind. NO ADDITIONAL GATE IS
 * APPLIED HERE, and that is a decision rather than an omission: this is the only route by which a
 * paid competition can be withdrawn, so a guard stricter than platform_ops would not harden the
 * product, it would remove the hatch and leave the organiser permanently stuck behind the block
 * that exists to protect their candidates.
 *
 * The list is the blocked set itself, not a search box. An operator answering a support request
 * knows the competition by name, not by id, and a hatch that requires knowing an id is a hatch only
 * its author can open.
 */
export default async function AdminBlockedPaymentsPage() {
  const competitions = await loadOpsBlockedCompetitions();
  const proofCount = competitions.reduce((total, entry) => total + entry.proofs.length, 0);

  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Pembayaran tertahan"
        description="Kompetisi yang tidak dapat ditarik penyelenggaranya karena masih ada bukti transfer berjalan."
        actions={<span className="status-badge data-text">{`${proofCount} bukti transfer`}</span>}
      />

      {/* DEC-0130 stated at the top, because both actions below are taken by people who will be
          asked about refunds and neither action can produce one. */}
      <Feedback tone="warning">
        Lombakita tidak pernah menampung dana peserta — setiap transfer masuk langsung ke rekening
        lembaga penyelenggara. Tidak ada tindakan di halaman ini yang mengembalikan uang peserta,
        dan tidak ada satupun yang dapat dibatalkan setelah dijalankan.
      </Feedback>

      {competitions.length === 0 ? (
        <EmptyState
          icon="check"
          title="Tidak ada pembayaran yang tertahan"
          description="Setiap kompetisi berbayar dapat ditarik penyelenggaranya sendiri saat ini."
        />
      ) : (
        <OpsPaymentActions
          competitions={competitions.map((competition) => ({
            competitionId: competition.competitionId,
            title: competition.title,
            institutionSlug: competition.institutionSlug,
            slug: competition.slug,
            status: competition.status,
            // The hatch's CAS refuses anything but `published`, so the control is withheld rather
            // than offered and then refused.
            cancellable: competition.status === "published",
            proofs: competition.proofs.map((proof) => ({
              proofId: proof.proofId,
              status: proof.status,
              submittedAt: proof.submittedAt.toISOString(),
              attempt: proof.attempt,
              grossAmount: proof.grossAmount,
              currency: proof.currency,
              dueAt: proof.dueAt?.toISOString() ?? null,
              payerDisplayName: proof.payerDisplayName,
              voidable: proof.voidable,
            })),
          }))}
        />
      )}
    </main>
  );
}
