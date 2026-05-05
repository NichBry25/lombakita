import { redirect } from "next/navigation";
import { InstitutionCompetitionDetailShell } from "@/components/institution/institution-competition-detail-shell";
import { getCurrentSession } from "@/server/auth/session";

type Props = { params: Promise<{ institutionSlug: string; competitionId: string }> };

export default async function InstitutionCompetitionDetailPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionId } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionId}`;
  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
  }
  return (
    <InstitutionCompetitionDetailShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
    />
  );
}
