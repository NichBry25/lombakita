import { InstitutionTeamShell } from "@/components/institution/institution-team-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import { redirect } from "next/navigation";

type InstitutionTeamPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionTeamPage({ params }: InstitutionTeamPageProps) {
  const { institutionSlug } = await params;
  const teamPath = `/institution/${institutionSlug}/settings/team`;
  const session = await requireRolePage("recruiter", { callbackPath: teamPath });

  // Invitation issuance is owner-or-staff per institution_invitation_step_2_3.issuer_roles.
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  const isPersonal = isPersonalInstitutionType(await loadInstitutionTypeBySlug(institutionSlug));

  return <InstitutionTeamShell institutionSlug={institutionSlug} isPersonal={isPersonal} />;
}
