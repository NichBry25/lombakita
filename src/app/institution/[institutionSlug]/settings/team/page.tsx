import { InstitutionTeamShell } from "@/components/institution/institution-team-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { redirect } from "next/navigation";

type InstitutionTeamPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionTeamPage({ params }: InstitutionTeamPageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const teamPath = `/institution/${institutionSlug}/settings/team`;

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(teamPath)}`);
  }

  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  // Invitation issuance is owner-or-staff per institution_invitation_step_2_3.issuer_roles.
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  return <InstitutionTeamShell institutionSlug={institutionSlug} />;
}
