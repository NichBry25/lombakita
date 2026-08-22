import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { getDb } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdentityByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { loadOrganiserPaymentQueue } from "@/server/finance/organiser-payment-review";
import { OrganiserPaymentQueue } from "@/components/finance/organiser-payment-queue";
import { ButtonLink, Feedback, PageHeader } from "@/components/ui";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string }>;
};

export const metadata = {
  title: "Verifikasi pembayaran",
  description: "Tinjau bukti transfer peserta untuk kompetisi berbayar.",
};

/**
 * The organiser's bukti transfer queue for one competition.
 *
 * THREE SEPARATE GATES, in this order, and none of them is redundant. `requireRolePage` establishes
 * that a recruiter is signed in. `requireAdminInstitutionBySlug` establishes that this recruiter
 * administers THIS institution. A recruiter elsewhere is not one here. The tenant scope inside
 * `loadOrganiserPaymentQueue` then establishes that the competition belongs to that institution,
 * which the first two cannot answer: an owner of institution D asking for institution A's
 * competition passes both of them.
 *
 * The read is scoped in the query rather than filtered afterwards, so a foreign competition yields
 * an EMPTY queue rather than a refusal. A refusal would confirm the competition exists.
 */
export default async function CompetitionPaymentsPage({ params }: Props) {
  const { institutionSlug, competitionSlug } = await params;

  const path = `/institution/${institutionSlug}/competitions/${competitionSlug}/payments`;
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

  let competitionId: string;
  let competitionTitle: string;
  try {
    ({ id: competitionId, title: competitionTitle } =
      await getCompetitionIdentityByInstitutionAndSlug(institutionSlug, competitionSlug, db));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError) notFound();
    throw error;
  }

  const proofs = await loadOrganiserPaymentQueue(institutionId, competitionId, db);
  const awaitingCount = proofs.filter((proof) => proof.status === "pending_review").length;

  return (
    <main className="page-shell app-page">
      <PageHeader
        eyebrow={competitionTitle}
        title="Verifikasi pembayaran"
        backHref={`/institution/${institutionSlug}/competitions/${competitionSlug}`}
        actions={
          <ButtonLink
            href={`/institution/${institutionSlug}/competitions/${competitionSlug}/participants`}
            variant="outline"
          >
            Peserta
          </ButtonLink>
        }
      />

      <p className="lead-copy">
        Cocokkan setiap bukti transfer dengan mutasi rekening Anda sebelum memberi keputusan.
      </p>

      {/* The banner slot now carries the one thing that changes: how much work is waiting. The
          custody disclosure it replaced said nothing an organiser could act on, and it sat above
          the queue on every visit. What that disclosure was protecting, a reviewer treating
          verification as the platform vouching for the money, is stated on the control itself. */}
      {awaitingCount > 0 ? (
        <Feedback tone="info">
          {`${awaitingCount} bukti transfer menunggu keputusan Anda.`}
        </Feedback>
      ) : null}

      <OrganiserPaymentQueue
        institutionSlug={institutionSlug}
        competitionId={competitionId}
        proofs={proofs.map((proof) => ({
          proofId: proof.proofId,
          status: proof.status,
          submittedAt: proof.submittedAt.toISOString(),
          originalFileName: proof.originalFileName,
          fileSizeBytes: proof.fileSizeBytes,
          grossAmount: proof.grossAmount,
          currency: proof.currency,
          dueAt: proof.dueAt?.toISOString() ?? null,
          payerDisplayName: proof.payer.displayName,
          priorAttempts: proof.priorAttempts,
          rejectionReason: proof.rejectionReason,
          resubmissionAllowed: proof.resubmissionAllowed,
        }))}
      />
    </main>
  );
}
