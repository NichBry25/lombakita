import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { InstitutionCompetitionEditShell } from "@/components/institution/institution-competition-edit-shell";
import { CompetitionPrizesEditor } from "@/components/institution/competition-prizes-editor";
import { CompetitionRoundsEditor } from "@/components/institution/competition-rounds-editor";
import { CompetitionTagsEditor } from "@/components/institution/competition-tags-editor";
import { CompetitionEligibilityEditor } from "@/components/institution/competition-eligibility-editor";
import { AccessError } from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

type Props = { params: Promise<{ institutionSlug: string; competitionSlug: string }> };

export default async function InstitutionCompetitionEditPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug, competitionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionSlug}/edit`;
  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
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

  const isPersonal = isPersonalInstitutionType(await loadInstitutionTypeBySlug(institutionSlug));

  return (
    <InstitutionCompetitionEditShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
      isPersonal={isPersonal}
    >
      <CompetitionRoundsEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionPrizesEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionTagsEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionEligibilityEditor
        competitionId={competitionId}
        expectedUserId={session.user.id}
      />
    </InstitutionCompetitionEditShell>
  );
}
