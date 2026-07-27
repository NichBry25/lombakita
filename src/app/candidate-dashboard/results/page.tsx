import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";
import { listCandidatePublishedResults } from "@/server/participants/result-service";

export default async function CandidateResultsPage() {
  const session = await requireRolePage("candidate", {
    callbackPath: "/candidate-dashboard/results",
    missingRoleRedirect: "/auth/verify-role?as=candidate",
  });

  const results = await listCandidatePublishedResults(session.user.id);

  return (
    <main className="page-shell app-page candidate-results-page">
      <PageHeader
        eyebrow="Keputusan penyelenggara"
        title="Hasil kompetisi"
        description="Hasil yang telah dipublikasikan untuk pendaftaranmu."
        backHref="/candidate-dashboard"
        backLabel="Dasbor"
      />

      {results.length === 0 ? (
        <EmptyState
          icon="trophy"
          title="Belum ada hasil yang dipublikasikan."
          description="Keputusan final akan terlihat setelah penyelenggara mempublikasikannya."
        />
      ) : (
        <ul className="record-list">
          {results.map((result) => (
            <li key={result.registrationId} className="record-row result-row">
              <span className="result-mark" aria-hidden="true">
                #
              </span>
              <div className="record-row-main">
                <Link
                  href={`/candidate-dashboard/results/${result.registrationId}`}
                  className="record-row-title"
                >
                  {result.competitionTitle}
                </Link>
                <span className="record-meta data-text">
                  {result.publishedAt.toLocaleDateString("id-ID", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </div>
              <span className="result-label">{result.resultLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
