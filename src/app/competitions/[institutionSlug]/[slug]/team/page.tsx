import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/server/auth/session";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";
import { getTeamForCompetitionAndCandidate } from "@/server/teams/team-service";
import { TeamShell } from "./team-shell";

export default async function CompetitionTeamPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  const { institutionSlug, slug } = await params;
  const session = await getCurrentSession();

  if (!session?.user) {
    redirect(`/auth/sign-in?callbackUrl=/competitions/${institutionSlug}/${slug}/team`);
  }

  if (session.user.role !== "candidate") {
    return (
      <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22 }}>Hanya kandidat yang dapat membuat tim</h1>
        <p style={{ marginTop: 8, color: "#555" }}>
          Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk membentuk tim.
        </p>
        <p style={{ marginTop: 12 }}>
          <Link href={`/competitions/${institutionSlug}/${slug}`} style={{ color: "#355795" }}>
            ← Kembali ke detail kompetisi
          </Link>
        </p>
      </main>
    );
  }

  const competition = await getPublicCompetitionDetail(institutionSlug, slug);
  if (!competition) notFound();

  const supportsTeams = competition.mode === "team" || competition.mode === "both";

  const initialTeam = supportsTeams
    ? await getTeamForCompetitionAndCandidate(session.user.id, competition.id)
    : null;

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <Link
        href={`/competitions/${institutionSlug}/${slug}`}
        style={{ fontSize: 14, color: "#555" }}
      >
        ← {competition.title}
      </Link>

      <h1 style={{ marginTop: 16, fontSize: 24 }}>Tim untuk {competition.title}</h1>

      {!supportsTeams ? (
        <p style={{ marginTop: 16, color: "#a23" }}>
          Kompetisi ini tidak menerima pendaftaran tim (mode: {competition.mode ?? "—"}).
        </p>
      ) : (
        <TeamShell
          competitionId={competition.id}
          competitionMaxTeamSize={competition.maxTeamSize}
          initialTeam={
            initialTeam
              ? {
                  team: {
                    ...initialTeam.team,
                    createdAt: initialTeam.team.createdAt.toISOString(),
                    updatedAt: initialTeam.team.updatedAt.toISOString(),
                  },
                  roster: initialTeam.roster.map((r) => ({
                    ...r,
                    joinedAt: r.joinedAt.toISOString(),
                  })),
                  pendingInvitations: initialTeam.pendingInvitations.map((p) => ({
                    ...p,
                    expiresAt: p.expiresAt.toISOString(),
                    createdAt: p.createdAt.toISOString(),
                  })),
                }
              : null
          }
          currentUserId={session.user.id}
        />
      )}
    </main>
  );
}
