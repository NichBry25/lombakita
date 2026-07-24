import { notFound, redirect } from "next/navigation";
import { sessionHasRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";
import { getStudentRegistration } from "@/server/registrations/registration-service";
import { getTeamForCompetitionAndCandidate } from "@/server/teams/team-service";
import { IndividualRegistrationSection } from "./individual-section";
import { CompetitionTeamSection } from "./team-section";
import { PageHeader } from "@/components/ui";

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
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(registrationPath)}`);
  }

  if (!sessionHasRole(session.user.role, session.user.verifiedRoles, "candidate")) {
    return (
      <main className="page-shell app-page registration-page">
        <PageHeader
          eyebrow="Akses pendaftaran"
          title="Hanya kandidat yang dapat mendaftar"
          description="Akun kandidat yang terverifikasi diperlukan untuk memulai pendaftaran kompetisi."
          backHref={detailPath}
          backLabel="Kembali ke detail kompetisi"
        />
        <p className="feedback" data-tone="warning">
          Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk mendaftar ke kompetisi
          ini.
        </p>
      </main>
    );
  }

  const competition = await getPublicCompetitionDetail(institutionSlug, slug);
  if (!competition) notFound();

  const supportsTeams = competition.mode === "team" || competition.mode === "both";
  const supportsIndividual = competition.mode === "individual" || competition.mode === "both";

  // Individual side: load the calling candidate's existing registration (if any).
  const initialRegistration = supportsIndividual
    ? await getStudentRegistration(session.user.id, competition.id)
    : null;

  // Team side: load team snapshot so the section renders fully server-side. After every client
  // mutation the section calls router.refresh() which re-runs this page and re-fetches all of this.
  const teamSnapshot = supportsTeams
    ? await getTeamForCompetitionAndCandidate(session.user.id, competition.id)
    : null;
  const teamMembers = teamSnapshot
    ? teamSnapshot.roster.map((m) => ({
        membershipId: m.membershipId,
        userId: m.userId,
        role: m.role,
        displayName: m.displayName,
        email: m.email,
      }))
    : [];
  const teamPendingInvitations = teamSnapshot
    ? teamSnapshot.pendingInvitations.map((p) => ({
        id: p.id,
        tokenHash: p.tokenHash,
        invitedEmail: p.invitedEmail,
        expiresAt: p.expiresAt.toISOString(),
      }))
    : [];

  const registrationOpen = competition.ctaState === "open";

  return (
    <main className="page-shell app-page registration-page">
      <PageHeader
        eyebrow="Pendaftaran kompetisi"
        title="Daftarkan diri"
        description={
          competition.mode === "both"
            ? "Kompetisi ini menerima pendaftaran individu maupun tim."
            : competition.mode === "team"
              ? "Kompetisi ini wajib didaftarkan sebagai tim."
              : "Kompetisi ini menerima pendaftaran individu."
        }
        backHref={detailPath}
        backLabel={competition.title}
      />

      {!registrationOpen && (
        <div role="alert" className="feedback" data-tone="warning">
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
          modeLabel={competition.mode === "both" ? "Daftar sebagai individu" : "Daftar"}
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
          initialMembers={teamMembers}
          initialPendingInvitations={teamPendingInvitations}
        />
      )}
    </main>
  );
}
