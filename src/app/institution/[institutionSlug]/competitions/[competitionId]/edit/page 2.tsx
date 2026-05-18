import { redirect } from "next/navigation";
import { InstitutionCompetitionEditShell } from "@/components/institution/institution-competition-edit-shell";
import { getCurrentSession } from "@/server/auth/session";

type Props = { params: Promise<{ institutionSlug: string; competitionId: string }> };

export default async function InstitutionCompetitionEditPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionId } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionId}/edit`;
  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
  }
  return (
    <InstitutionCompetitionEditShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
    />
  );
}
