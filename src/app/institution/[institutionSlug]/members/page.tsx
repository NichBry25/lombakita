import { redirect } from "next/navigation";
import { InstitutionMembersShell } from "@/components/institution/institution-members-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type InstitutionMembersPageProps = {
  params: Promise<{
    institutionSlug: string;
  }>;
};

export default async function InstitutionMembersPage({ params }: InstitutionMembersPageProps) {
  const { institutionSlug } = await params;
  const membersPath = `/institution/${institutionSlug}/members`;
  const session = await requireRolePage("recruiter", { callbackPath: membersPath });

  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  return (
    <InstitutionMembersShell institutionSlug={institutionSlug} actorUserId={session.user.id} />
  );
}
