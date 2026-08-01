import { redirect } from "next/navigation";
import { InstitutionCompetitionCreateShell } from "@/components/institution/institution-competition-create-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type Props = { params: Promise<{ institutionSlug: string }> };

export default async function InstitutionCompetitionCreatePage({ params }: Props) {
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions/new`;
  const session = await requireRolePage("recruiter", { callbackPath: path });
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }
  return <InstitutionCompetitionCreateShell institutionSlug={institutionSlug} />;
}
