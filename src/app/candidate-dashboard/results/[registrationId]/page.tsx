import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { ButtonLink, Icon, PageHeader } from "@/components/ui";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { getDb } from "@/server/db/client";
import { competitionRegistrations, competitions, institutions } from "@/server/db/schema";
import { getPublishedResultForCandidate } from "@/server/participants/result-service";

type Props = {
  params: Promise<{ registrationId: string }>;
};

export default async function CandidateResultDetailPage({ params }: Props) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/candidate-dashboard/results");
  }

  const unverified = await getUnverifiedRoles(session.user.id);
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const { registrationId } = await params;
  const db = getDb();

  const [registration] = await db
    .select({
      competitionId: competitionRegistrations.competitionId,
      competitionTitle: competitions.title,
      institutionSlug: institutions.slug,
      competitionSlug: competitions.slug,
    })
    .from(competitionRegistrations)
    .innerJoin(competitions, eq(competitions.id, competitionRegistrations.competitionId))
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(
      and(
        eq(competitionRegistrations.id, registrationId),
        eq(competitionRegistrations.studentId, session.user.id),
      ),
    )
    .limit(1);

  if (!registration) {
    notFound();
  }

  const result = await getPublishedResultForCandidate(
    session.user.id,
    registration.competitionId,
    registrationId,
    db,
  );

  if (!result) {
    notFound();
  }

  return (
    <main className="page-shell app-page candidate-result-detail">
      <PageHeader
        eyebrow="Hasil kompetisi"
        title={registration.competitionTitle}
        description="Keputusan resmi yang telah dipublikasikan oleh penyelenggara."
        backHref="/candidate-dashboard/results"
        backLabel="Semua hasil"
        actions={
          <ButtonLink
            href={`/competitions/${registration.institutionSlug}/${registration.competitionSlug}`}
            variant="outline"
            size="sm"
          >
            Lihat kompetisi
          </ButtonLink>
        }
      />

      <section className="result-hero brand-band">
        <span className="result-hero-icon" aria-hidden="true">
          <Icon name="trophy" size="xl" />
        </span>
        <div className="stack-xs">
          <p className="eyebrow">Hasil</p>
          <p className="result-hero-label">{result.resultLabel}</p>
        </div>
      </section>

      {result.resultNotes ? (
        <section className="surface-card card-padding-lg stack-sm">
          <p className="eyebrow">Catatan penyelenggara</p>
          <p className="result-notes">{result.resultNotes}</p>
        </section>
      ) : null}
    </main>
  );
}
