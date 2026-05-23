import { redirect } from "next/navigation";
import { InstitutionMembersShell } from "@/components/institution/institution-members-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type InstitutionMembersPageProps = {
  params: Promise<{
    institutionSlug: string;
  }>;
};

export default async function InstitutionMembersPage({ params }: InstitutionMembersPageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const membersPath = `/institution/${institutionSlug}/members`;

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(membersPath)}`);
  }

  if (session.user.role !== "recruiter") {
    redirect("/");
  }

  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }

  return (
    <InstitutionMembersShell
      institutionSlug={institutionSlug}
      actorUserId={session.user.id}
    />
  );
}
