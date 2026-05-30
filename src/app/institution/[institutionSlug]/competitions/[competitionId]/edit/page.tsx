import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { InstitutionCompetitionEditShell } from "@/components/institution/institution-competition-edit-shell";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionForReader } from "@/server/competitions/competition-service";

type Props = { params: Promise<{ institutionSlug: string; competitionId: string }> };

export default async function InstitutionCompetitionEditPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionId } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionId}/edit`;
  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  try {
    await getCompetitionForReader(session.user.id, session.user.role, competitionId);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError || error instanceof AccessError) {
      notFound();
    }
    throw error;
  }

  return (
    <InstitutionCompetitionEditShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
    />
  );
}
