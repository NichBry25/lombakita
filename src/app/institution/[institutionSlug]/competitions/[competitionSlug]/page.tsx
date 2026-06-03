import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { InstitutionCompetitionDetailShell } from "@/components/institution/institution-competition-detail-shell";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type Props = { params: Promise<{ institutionSlug: string; competitionSlug: string }> };

export default async function InstitutionCompetitionDetailPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionSlug}`;
  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  let competitionId: string;
  try {
    competitionId = await getCompetitionIdByInstitutionAndSlug(institutionSlug, competitionSlug);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError || error instanceof AccessError) notFound();
    throw error;
  }

  return (
    <InstitutionCompetitionDetailShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
    />
  );
}
