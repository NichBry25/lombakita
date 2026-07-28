import { redirect } from "next/navigation";
import { InstitutionTeamShell } from "@/components/institution/institution-team-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

type InstitutionTeamPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionTeamPage({ params }: InstitutionTeamPageProps) {
  const { institutionSlug } = await params;
  const teamPath = `/institution/${institutionSlug}/team`;

  // CCR-05 / CCR-09: only recruiter-verified accounts can ever own or staff an institution.
  const session = await requireRolePage("recruiter", { callbackPath: teamPath });

  // Member administration and invitation issuance are both owner-or-staff per
  // institution_invitation_step_2_3.issuer_roles.
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  const isPersonal = isPersonalInstitutionType(await loadInstitutionTypeBySlug(institutionSlug));

  return (
    <InstitutionTeamShell
      institutionSlug={institutionSlug}
      actorUserId={session.user.id}
      isPersonal={isPersonal}
    />
  );
}
