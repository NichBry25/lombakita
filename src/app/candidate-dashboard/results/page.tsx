import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { listCandidatePublishedResults } from "@/server/participants/result-service";

export default async function CandidateResultsPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/candidate-dashboard/results");
  }

  const unverified = await getUnverifiedRoles(session.user.id);
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const results = await listCandidatePublishedResults(session.user.id);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/candidate-dashboard" style={{ color: "#355795", fontSize: "0.9em" }}>
          ← Dasbor Kandidat
        </Link>
      </p>
      <h1 style={{ marginBottom: "1.5rem" }}>Hasil Kompetisi</h1>

      {results.length === 0 ? (
        <p style={{ color: "#777" }}>Belum ada hasil yang dipublikasikan.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {results.map((r) => (
            <li
              key={r.registrationId}
              style={{ padding: "0.75rem 1rem", background: "#f9f9f9", borderRadius: 4, borderLeft: "3px solid #355795" }}
            >
              <Link
                href={`/candidate-dashboard/results/${r.registrationId}`}
                style={{ fontWeight: 600, color: "#355795" }}
              >
                {r.competitionTitle}
              </Link>
              <span style={{ marginLeft: 8, color: "#555", fontSize: "0.9em" }}>— {r.resultLabel}</span>
              <div style={{ marginTop: 4, fontSize: "0.85em", color: "#888" }}>
                {r.publishedAt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
