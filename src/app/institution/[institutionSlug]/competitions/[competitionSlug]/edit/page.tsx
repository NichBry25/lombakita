import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { InstitutionCompetitionEditShell } from "@/components/institution/institution-competition-edit-shell";
import { CompetitionPrizesEditor } from "@/components/institution/competition-prizes-editor";
import { CompetitionRoundsEditor } from "@/components/institution/competition-rounds-editor";
import { CompetitionTagsEditor } from "@/components/institution/competition-tags-editor";
import { CompetitionEligibilityEditor } from "@/components/institution/competition-eligibility-editor";
import { CompetitionFeeSection } from "@/components/institution/competition-fee-section";
import type { CompetitionStep } from "@/components/institution/competition-steps";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { resolveCompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string }>;
  searchParams?: Promise<{ langkah?: string | string[] }>;
};

// Only a single one-digit step is a step; anything else lets the shell pick where a draft resumes.
const parseCompetitionStep = (langkah: string | string[] | undefined): CompetitionStep | null => {
  if (typeof langkah !== "string" || !/^[1-5]$/.test(langkah)) return null;
  return Number(langkah) as CompetitionStep;
};

export default async function InstitutionCompetitionEditPage({ params, searchParams }: Props) {
  const { institutionSlug, competitionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions/${competitionSlug}/edit`;
  const session = await requireRolePage("recruiter", { callbackPath: path });
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }
  const query = await searchParams;
  const step = parseCompetitionStep(query?.langkah);

  let competitionId: string;
  try {
    competitionId = await getCompetitionIdByInstitutionAndSlug(institutionSlug, competitionSlug);
  } catch (error) {
    if (error instanceof AccessError && error.code === "account_state_unavailable") throw error;
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError || error instanceof AccessError) notFound();
    throw error;
  }

  const isPersonal = isPersonalInstitutionType(await loadInstitutionTypeBySlug(institutionSlug));

  // The first paint's answer. The shell refreshes it from the competition read after every save,
  // which is what makes the control reflect the state that was just written rather than the state
  // the form was opened on.
  const publishReadiness = await resolveCompetitionPublishReadiness(session.user.id, competitionId);

  return (
    <InstitutionCompetitionEditShell
      institutionSlug={institutionSlug}
      competitionId={competitionId}
      expectedUserId={session.user.id}
      initialPublishReadiness={publishReadiness}
      isPersonal={isPersonal}
      step={step}
      stepChildren={{
        1: <CompetitionTagsEditor competitionId={competitionId} expectedUserId={session.user.id} />,
        2: (
          <CompetitionEligibilityEditor
            competitionId={competitionId}
            expectedUserId={session.user.id}
          />
        ),
        3: (
          <CompetitionRoundsEditor competitionId={competitionId} expectedUserId={session.user.id} />
        ),
        4: (
          <>
            <CompetitionPrizesEditor
              competitionId={competitionId}
              expectedUserId={session.user.id}
            />
            <CompetitionFeeSection competitionId={competitionId} expectedUserId={session.user.id} />
          </>
        ),
      }}
    >
      <CompetitionRoundsEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionPrizesEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionTagsEditor competitionId={competitionId} expectedUserId={session.user.id} />
      <CompetitionEligibilityEditor
        competitionId={competitionId}
        expectedUserId={session.user.id}
      />
      <CompetitionFeeSection competitionId={competitionId} expectedUserId={session.user.id} />
    </InstitutionCompetitionEditShell>
  );
}
