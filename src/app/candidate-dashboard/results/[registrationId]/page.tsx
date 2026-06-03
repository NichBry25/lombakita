import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { getPublishedResultForCandidate } from "@/server/participants/result-service";
import { getDb } from "@/server/db/client";
import { and, eq } from "drizzle-orm";
import { competitionRegistrations, competitions, institutions } from "@/server/db/schema";

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

  // Load registration context for display (competition title, slug).
  const [reg] = await db
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

  if (!reg) {
    notFound();
  }

  const result = await getPublishedResultForCandidate(
    session.user.id,
    reg.competitionId,
    registrationId,
    db,
  );

  if (!result) {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/candidate-dashboard/results" style={{ color: "#355795", fontSize: "0.9em" }}>
          ← Semua hasil
        </Link>
      </p>
      <h1 style={{ marginBottom: "0.5rem" }}>{reg.competitionTitle}</h1>
      <p style={{ marginBottom: "1.5rem", color: "#555", fontSize: "0.9em" }}>
        <Link href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}`} style={{ color: "#355795" }}>
          Lihat kompetisi
        </Link>
      </p>

      <div style={{ padding: "1rem", background: "#f0f5ff", borderRadius: 6, borderLeft: "4px solid #355795" }}>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.85em", color: "#555", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Hasil
        </p>
        <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "#0F1012" }}>
          {result.resultLabel}
        </p>
        {result.resultNotes && (
          <p style={{ margin: "0.75rem 0 0", color: "#333", whiteSpace: "pre-wrap" }}>
            {result.resultNotes}
          </p>
        )}
      </div>
    </main>
  );
}
