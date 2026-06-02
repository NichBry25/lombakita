import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import {
  listCandidateIndividualRegistrations,
  listCandidateTeamRegistrations,
} from "@/server/candidate-registrations/candidate-registration-service";
import { deriveUpcomingDeadlines } from "@/server/candidate-registrations/deadline-utils";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";

export default async function CandidateDashboardPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/candidate-dashboard");
  }

  const unverified = await getUnverifiedRoles(session.user.id);

  // DEC-0060 — access to role-scoped surfaces is derived per-request from verification state.
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const showRecruiterBanner = unverified.includes("recruiter");

  const [individualRegs, teamRegs, savedResult] = await Promise.all([
    listCandidateIndividualRegistrations(session.user.id),
    listCandidateTeamRegistrations(session.user.id),
    listSavedCompetitions(session.user.id, { limit: 5 }),
  ]);

  const upcomingDeadlines = deriveUpcomingDeadlines([...individualRegs, ...teamRegs]);

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "1rem" }}>Dasbor Kandidat</h1>

      {showRecruiterBanner ? (
        <SecondRoleBanner unverifiedRole="recruiter" userId={session.user.id} />
      ) : null}

      {/* Upcoming Deadlines */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", borderBottom: "1px solid #ddd", paddingBottom: "0.4rem" }}>
          Tenggat Mendatang
        </h2>
        {upcomingDeadlines.length === 0 ? (
          <p style={{ color: "#777" }}>Tidak ada tenggat mendatang.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {upcomingDeadlines.map((d, i) => (
              <li key={i} style={{ padding: "0.5rem 0.75rem", background: "#f5f5f5", borderRadius: 4 }}>
                <span style={{ fontWeight: 500 }}>{d.competitionTitle}</span>
                {" — "}
                <span style={{ color: "#555" }}>
                  {d.label === "registration_closes" ? "Pendaftaran tutup" : "Acara dimulai"}
                </span>
                {": "}
                <span>{d.date.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Individual Registrations */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", borderBottom: "1px solid #ddd", paddingBottom: "0.4rem" }}>
          Pendaftaran Individu
        </h2>
        {individualRegs.length === 0 ? (
          <p style={{ color: "#777" }}>Belum ada pendaftaran individu.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {individualRegs.map((reg) => {
              const deadline = reg.registrationEndAt && reg.registrationEndAt > new Date()
                ? reg.registrationEndAt
                : reg.eventStartAt && reg.eventStartAt > new Date()
                  ? reg.eventStartAt
                  : null;
              return (
                <li key={reg.id} style={{ padding: "0.5rem 0.75rem", background: "#f9f9f9", borderRadius: 4 }}>
                  <Link href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}`} style={{ fontWeight: 500 }}>
                    {reg.competitionTitle}
                  </Link>
                  {" — "}
                  <span style={{ color: reg.registrationStatus === "cancelled" ? "#c00" : "#060" }}>
                    {reg.registrationStatus === "confirmed" ? "Terdaftar" : reg.registrationStatus === "cancelled" ? "Dibatalkan" : reg.registrationStatus}
                  </span>
                  {deadline ? (
                    <span style={{ color: "#555", fontSize: "0.9em" }}>
                      {" · "}
                      {deadline.toLocaleDateString("id-ID", { day: "numeric", month: "long" })}
                    </span>
                  ) : null}
                  {" · "}
                  <Link href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}/registration/`} style={{ fontSize: "0.9em", color: "#355795" }}>
                    Detail
                  </Link>
                  {" · "}
                  <Link href={`/candidate-dashboard/registrations/${reg.id}`} style={{ fontSize: "0.9em", color: "#355795" }}>
                    Submission
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Team Registrations */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", borderBottom: "1px solid #ddd", paddingBottom: "0.4rem" }}>
          Pendaftaran Tim
        </h2>
        {teamRegs.length === 0 ? (
          <p style={{ color: "#777" }}>Belum ada pendaftaran tim.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {teamRegs.map((reg) => {
              const deadline = reg.registrationEndAt && reg.registrationEndAt > new Date()
                ? reg.registrationEndAt
                : reg.eventStartAt && reg.eventStartAt > new Date()
                  ? reg.eventStartAt
                  : null;
              return (
                <li key={reg.id} style={{ padding: "0.5rem 0.75rem", background: "#f9f9f9", borderRadius: 4 }}>
                  <Link href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}`} style={{ fontWeight: 500 }}>
                    {reg.competitionTitle}
                  </Link>
                  {" — "}
                  <span style={{ fontStyle: "italic", color: "#444" }}>{reg.teamName}</span>
                  {" · "}
                  <span style={{ fontSize: "0.85em", color: reg.isCaptain ? "#355795" : "#666", fontWeight: reg.isCaptain ? 600 : 400 }}>
                    {reg.isCaptain ? "Kapten" : "Anggota"}
                  </span>
                  {" · "}
                  <span style={{ color: reg.registrationStatus === "cancelled" ? "#c00" : "#060" }}>
                    {reg.registrationStatus === "confirmed" ? "Terdaftar" : reg.registrationStatus === "cancelled" ? "Dibatalkan" : reg.registrationStatus}
                  </span>
                  {deadline ? (
                    <span style={{ color: "#555", fontSize: "0.9em" }}>
                      {" · "}
                      {deadline.toLocaleDateString("id-ID", { day: "numeric", month: "long" })}
                    </span>
                  ) : null}
                  {" · "}
                  <Link href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}/registration/`} style={{ fontSize: "0.9em", color: "#355795" }}>
                    Detail
                  </Link>
                  {" · "}
                  <Link href={`/candidate-dashboard/registrations/${reg.id}`} style={{ fontSize: "0.9em", color: "#355795" }}>
                    Submission
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Results */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", borderBottom: "1px solid #ddd", paddingBottom: "0.4rem" }}>
          Hasil Kompetisi
        </h2>
        <p style={{ color: "#777", marginBottom: "0.5rem" }}>
          Lihat hasil kompetisi yang telah dipublikasikan oleh penyelenggara.
        </p>
        <p>
          <Link href="/candidate-dashboard/results" style={{ color: "#355795", fontSize: "0.9em" }}>
            Lihat semua hasil →
          </Link>
        </p>
      </section>

      {/* Saved Competitions Preview */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", borderBottom: "1px solid #ddd", paddingBottom: "0.4rem" }}>
          Tersimpan
        </h2>
        {savedResult.data.length === 0 ? (
          <p style={{ color: "#777" }}>Belum ada kompetisi yang disimpan.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {savedResult.data.map((item) => (
              <li key={item.competitionId} style={{ padding: "0.5rem 0.75rem", background: "#f9f9f9", borderRadius: 4 }}>
                {item.savedStatus === "available" ? (
                  <Link href={`/competitions/${item.institutionSlug}/${item.slug}`} style={{ fontWeight: 500 }}>
                    {item.title}
                  </Link>
                ) : (
                  <span style={{ fontWeight: 500, color: "#999" }}>{item.title}</span>
                )}
                {" — "}
                <span style={{ fontSize: "0.9em", color: "#777" }}>{item.institutionName}</span>
                {item.savedStatus === "unavailable" ? (
                  <span style={{ fontSize: "0.85em", color: "#999" }}> (tidak tersedia)</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p style={{ marginTop: "0.75rem" }}>
          <Link href="/saved" style={{ color: "#355795", fontSize: "0.9em" }}>
            Lihat semua kompetisi tersimpan →
          </Link>
        </p>
      </section>
    </main>
  );
}
