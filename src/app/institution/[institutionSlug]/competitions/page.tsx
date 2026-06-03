import { redirect } from "next/navigation";
import { InstitutionCompetitionsShell } from "@/components/institution/institution-competitions-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type Props = { params: Promise<{ institutionSlug: string }> };

export default async function InstitutionCompetitionsPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions`;
  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }
  // Competition admin is owner-or-staff per competition_step_3_1.role_enforcement.list.
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }
  return <InstitutionCompetitionsShell institutionSlug={institutionSlug} />;
}
