import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";
import { checkStudentEligibility } from "@/server/eligibility/eligibility-service";
import { getStudentRegistration } from "@/server/registrations/registration-service";
import { getTeamForCompetitionAndCandidate } from "@/server/teams/team-service";
import { IndividualRegistrationSection } from "./individual-section";
import { CompetitionTeamSection } from "./team-section";

// Dedicated registration surface. The detail page at `..` is read-only; candidates click
// "Daftar" there which navigates here. This separation keeps reading vs. registering distinct
// flows and gives the registration UI a full surface to host both individual and team paths.
export default async function CompetitionRegistrationPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  const { institutionSlug, slug } = await params;
  const session = await getCurrentSession();
  const detailPath = `/competitions/${institutionSlug}/${slug}`;
  const registrationPath = `${detailPath}/registration`;

  if (!session?.user) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(registrationPath)}`);
  }

  if (session.user.role !== "candidate") {
    return (
      <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
        <Link href={detailPath} style={{ fontSize: 14, color: "#555" }}>
          ← Kembali ke detail kompetisi
        </Link>
        <h1 style={{ marginTop: 16, fontSize: 22 }}>Hanya kandidat yang dapat mendaftar</h1>
        <p style={{ marginTop: 8, color: "#555" }}>
          Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk mendaftar ke kompetisi
          ini.
        </p>
      </main>
    );
  }

  const competition = await getPublicCompetitionDetail(institutionSlug, slug);
  if (!competition) notFound();

  const supportsTeams = competition.mode === "team" || competition.mode === "both";
  const supportsIndividual =
    competition.mode === "individual" || competition.mode === "both";

  // Individual side: load the calling candidate's existing registration (if any).
  const initialRegistration = supportsIndividual
    ? await getStudentRegistration(session.user.id, competition.id)
    : null;

  // Team side: load team snapshot + per-member eligibility so the section renders fully
  // server-side. After every client mutation the section calls router.refresh() which re-runs
  // this page and re-fetches all of this.
  const teamSnapshot = supportsTeams
    ? await getTeamForCompetitionAndCandidate(session.user.id, competition.id)
    : null;
  const teamMembersWithEligibility = teamSnapshot
    ? await Promise.all(
        teamSnapshot.roster.map(async (m) => {
          const elig = await checkStudentEligibility(m.userId);
          return {
            membershipId: m.membershipId,
            userId: m.userId,
            role: m.role,
            displayName: m.displayName,
            email: m.email,
            eligibility: { status: elig.status, reasons: elig.reasons },
          };
        }),
      )
    : [];
  const teamPendingInvitations = teamSnapshot
    ? teamSnapshot.pendingInvitations.map((p) => ({
        id: p.id,
        invitedEmail: p.invitedEmail,
        expiresAt: p.expiresAt.toISOString(),
      }))
    : [];

  const registrationOpen = competition.ctaState === "open";

  return (
    <main style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <Link href={detailPath} style={{ fontSize: 14, color: "#555" }}>
        ← {competition.title}
      </Link>

      <h1 style={{ marginTop: 16, fontSize: 24 }}>Daftarkan diri</h1>
      <p style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
        {competition.mode === "both"
          ? "Kompetisi ini menerima pendaftaran individu maupun tim."
          : competition.mode === "team"
            ? "Kompetisi ini wajib didaftarkan sebagai tim."
            : "Kompetisi ini menerima pendaftaran individu."}
      </p>

      {!registrationOpen && (
        <div
          role="alert"
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fff7d6",
            border: "1px solid #d4a000",
            borderRadius: 6,
            color: "#7a5500",
            fontSize: 13,
          }}
        >
          {competition.ctaState === "not_yet_open"
            ? "Pendaftaran belum dibuka."
            : "Pendaftaran sudah ditutup."}
        </div>
      )}

      {supportsIndividual && (
        <IndividualRegistrationSection
          competitionId={competition.id}
          ctaState={competition.ctaState}
          initialRegistration={
            initialRegistration
              ? { id: initialRegistration.id, status: initialRegistration.status }
              : null
          }
          expectedUserId={session.user.id}
          modeLabel={
            competition.mode === "both" ? "Daftar sebagai individu" : "Daftar"
          }
        />
      )}

      {supportsTeams && (
        <CompetitionTeamSection
          competitionId={competition.id}
          competitionMode={competition.mode}
          minTeamSize={competition.minTeamSize}
          maxTeamSize={competition.maxTeamSize}
          registrationOpen={registrationOpen}
          expectedUserId={session.user.id}
          initialTeam={
            teamSnapshot
              ? {
                  id: teamSnapshot.team.id,
                  name: teamSnapshot.team.name,
                  captainId: teamSnapshot.team.captainId,
                  status: teamSnapshot.team.status,
                }
              : null
          }
          initialMembers={teamMembersWithEligibility}
          initialPendingInvitations={teamPendingInvitations}
        />
      )}
    </main>
  );
}
