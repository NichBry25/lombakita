import { notFound, redirect } from "next/navigation";
import { sessionHasRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";
import { getStudentRegistration } from "@/server/registrations/registration-service";
import { getTeamForCompetitionAndCandidate } from "@/server/teams/team-service";
import { resolveCancelAffordanceState } from "@/server/finance/cancel-affordance";
import { resolveChargingReadinessBySlug } from "@/server/finance/charging-readiness";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
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
          title="Hanya kandidat yang dapat mendaftar"
          description="Akun kandidat yang terverifikasi diperlukan untuk memulai pendaftaran kompetisi."
          backHref={detailPath}
          backLabel="Detail"
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

  // Whether either cancel control may be offered at all (DEC-0131). Resolved through the same
  // predicate the two cancel services call, so the page cannot offer what the server refuses.
  const { individualCancellationClosed, teamCancellationClosed } =
    await resolveCancelAffordanceState({
      individualRegistration: initialRegistration,
      team: teamSnapshot?.team ?? null,
    });

  // DEC-0170, on the candidate's side of the same state. Verification can be revoked after a
  // competition was priced and published, so a paid competition whose organiser cannot currently
  // take payment is a state a candidate can genuinely arrive at, and the server WILL refuse the
  // registration. Asked here so the refusal is explained before the click rather than discovered by
  // it. The candidate is told only that payment is unavailable; which of the three conditions
  // failed is the organiser's business and is not surfaced.
  const paidRegistrationUnavailable =
    isPaidCompetition(competition.feeAmount) &&
    !(await resolveChargingReadinessBySlug(institutionSlug)).ready;

  const registrationOpen = competition.ctaState === "open";

  return (
    <main className="page-shell app-page registration-page">
      <PageHeader
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

      {paidRegistrationUnavailable && (
        <div role="alert" className="feedback" data-tone="warning">
          Kompetisi ini berbayar, tetapi penyelenggaranya belum dapat menerima pembayaran. Anda
          belum dapat mendaftar sekarang. Hubungi penyelenggara atau periksa kembali nanti.
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
          cancellationClosedByPaymentProof={individualCancellationClosed}
          registrationWithheld={paidRegistrationUnavailable}
        />
      )}

      {supportsTeams && (
        <CompetitionTeamSection
          competitionId={competition.id}
          competitionMode={competition.mode}
          minTeamSize={competition.minTeamSize}
          maxTeamSize={competition.maxTeamSize}
          registrationOpen={registrationOpen && !paidRegistrationUnavailable}
          expectedUserId={session.user.id}
          cancellationClosedByPaymentProof={teamCancellationClosed}
          registrationWithheld={paidRegistrationUnavailable}
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
