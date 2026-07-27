import { redirect } from "next/navigation";
import { InstitutionCompetitionsShell } from "@/components/institution/institution-competitions-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type Props = { params: Promise<{ institutionSlug: string }> };

export default async function InstitutionCompetitionsPage({ params }: Props) {
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions`;
  const session = await requireRolePage("recruiter", { callbackPath: path });
  // Competition admin is owner-or-staff per competition_step_3_1.role_enforcement.list.
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }
  return <InstitutionCompetitionsShell institutionSlug={institutionSlug} />;
}
